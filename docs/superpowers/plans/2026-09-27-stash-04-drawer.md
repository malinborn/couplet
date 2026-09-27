# Stash 04 — Stash Drawer UI Implementation Plan

> **⚠️ Roadmap amendments override this plan.** Read the section «Amendments after planning» in `2026-09-27-stash-00-roadmap.md` first. Most visible here: **A1 — the notes folder is `~/couplet/` (dev `~/couplet-dev/`), not `~/Documents/…`**: use `dirs::home_dir()` instead of `dirs::document_dir()`, rename every `Documents` base in tests to a home base, and drop every TCC-prompt note or step (the home root is not TCC-protected). Also A2 (offline build, `functions` feature), A3 (`repo` = directory name) and A5 (schema v2).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the stash its interface, exactly as the approved mockup draws it: a stash area at the bottom of the tabs drawer (button + «N · отложено сегодня M», and a drop zone «Отложить в тайник · N вкладок» while tab cards are dragged), a second drawer on the right edge in the stash colour with one flat list, sorts ⌘L/⌘R/⌘U, tag chips, a repo auto-filter, «открыта в #N», move semantics between the two drawers (and between windows), a dedup pulse, widths that never overlap (and a window that widens itself below 680px), focus by a glowing rim, ⌃S, ←/→ and Esc.

**Architecture:** Every decision is a pure function in `src/lib/stash/*.ts` with colocated vitest tests — drawer widths and the widen plan (`drawer-width.ts`), the query/filter (`stash-query.ts`), the visible list, sorts and time labels (`stash-view.ts`), the drawer-pair reducer and its key routing (`stash-state.ts`), drop targets (`drop-target.ts`), toast text (`stash-toast.ts`) and the put-away / open orchestration (`put-away.ts`, `open-from-stash.ts`). A per-window runes store (`stash-store.svelte.ts`) holds entries, counts, holders and the reducer state. Three thin components (`StashBar`, `StashDrawer`, `StashCard`) port the mockup's CSS. **The stash drawer is rendered inside `TabDrawer`'s `display: contents` root**, so the tabs drawer's focus trap, its one capture-phase `keydown` listener and its one drag machine cover both drawers; `TabDrawer` routes keys to the stash through a handle. Rust gains three read-only-or-routing tab commands (`tab_holders`, `tab_request_move`, `window_repo`), one event (`tab-pull`), the file branch of `stash_delete`, and a menu item. The window widens through `window-widen.ts` (`getCurrentWindow().setSize/setPosition`, clamped to `currentMonitor().workArea`).

**Tech Stack:** Tauri 2 (Rust), `@tauri-apps/api` 2.10 (`window` module: `setSize`, `setPosition`, `currentMonitor().workArea`), Svelte 5 runes, TypeScript strict, vitest (+ jsdom for components), Playwright (Google Chrome channel). **No new dependencies.**

**Sources of truth:** behaviour — `docs/superpowers/specs/2026-09-26-stash-design.md` «Интерфейс» and «Клавиатура»; look — `docs/investigations/2026-09-26-stash-mockup/stash-drawers.html` (git tag `stash-mockup-approved`); names — `docs/superpowers/plans/2026-09-27-stash-00-roadmap.md` «Shared contracts». Where the spec and the mockup disagree on visuals the mockup wins, on behaviour the spec wins; every conflict found while planning is in the table after the decisions.

**Out of scope here (later stages):** the trash view and note delete («Удалённые», «удалить», «вернуть», «удалить навсегда» — stage 06); FTS search, bm25, snippets (stage 05 swaps the text part of `stash-query.ts` / `stash-view.ts`); agent CLI/MCP (stage 07); broken-link cards «файл не найден» (not in this stage's scope list — see Known gaps).

**Additions to the roadmap's shared contracts, made in this stage** (the roadmap says a stage that needs something unlisted adds it and says so here):

| Addition | Kind | Why |
|---|---|---|
| `tab_holders { paths: string[] } → (TabHolder \| null)[]` (`TabHolder = { label: string, number: number \| null }`) | Tauri command, `tab_commands.rs` | «открыта в #N»: `StashEntry` does not say which window holds it |
| `tab_request_move { path: string } → PullAnswer` (`{kind:'not-open'} \| {kind:'this-window', tabId} \| {kind:'requested', label, number}`) + event `tab-pull { path, target }` to the holder | command + event | «открыть его отсюда — перенести из того окна»: `tab_move` is driven by the *source* window (its dirty checks, caret, inbox), so the target asks the holder to run it |
| `window_repo {} → string \| null` | Tauri command | the repo auto-filter needs the window project's name |
| `stash_delete { id }` **file branch now** (entry removed, file untouched); the note branch refuses until stage 06 turns it into the trash move | Tauri command (roadmap lists it for 06) | «убрать из тайника» for file refs is in this stage's scope |
| `src/lib/stash/stash-state.ts`, `stash-view.ts`, `drop-target.ts`, `stash-toast.ts`, `put-away.ts`, `open-from-stash.ts`, `icons.ts`, `StashIcon.svelte` | frontend modules | the roadmap's module table has only the store; these keep every decision pure and tested |
| `--color-stash` theme token (all 12 theme blocks) + `--stash-tint/-line/-soft` in `src/styles/stash.css` | theme contract | «своего цвета — производного от цвета ссылок темы» |
| menu item `toggle_stash` («Тайник», View → Tabs, no accelerator) | menu | roadmap Keys: «Menu item without accelerator» for ⌃S |

---

## Working rules (read before Task 0)

- **Worktree and branch:** the implementation worktree from `2026-09-27-stash-implementer-prompt.md`, branch `feat/stash`, after stages 02–03 are committed there. Run every command from the worktree root. Never `git stash`, `checkout`, `reset` or `restore`; `git add` explicit paths only and commit with the same pathspec (`git commit -m … -- <paths>`).
- **Commit trailer:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. One commit per task (Task 0 commits nothing).
- **Cargo:** every cargo command is prefixed with `CARGO_TARGET_DIR=~/.cargo/stash-impl-target`. Clippy: add no warnings to the baseline Task 0 records.
- **Frontend checks:** one file `npx vitest run <file>`; all `npx vitest run --dir src` (never `npm run test` — it overcounts worktree copies); types `npm run check`.
- **Never** `npm run tauri dev`, `npm run tauri build`, `npm run build:universal`, anything touching `/Applications`, `~/Documents/couplet/` or the release `stash.db`. Live checks: `npm run dev` (browser, private Vite in Task 23) or `npm run dev:app -- --features mcp-bridge` (dev identity, Task 24). Never kill a process you did not start. Never System Events / `osascript` / OS keystrokes.
- **Hotkeys match on `e.code`.** Synthetic `KeyboardEvent`s must carry `code`; Playwright's `page.keyboard` does.
- **Scratch directory:** `QA="${CLAUDE_JOB_DIR:-/tmp}/stash04"` — outside the repo. Every step that says `$QA` means this.
- **Name collision to keep in mind:** `controller.ts` already has a `stashActive()` — "stash" there means *parking a tab's state in the background* (tabs plan 02) and has nothing to do with the stash. Do not rename it; do not reuse the word for it.

## Preconditions from stages 02–03

This plan is written against the roadmap's contracts. Task 0 checks each name below in the real code and records any difference in `$QA/substitutions.md`; wherever this plan writes one of these names, use the recorded real name instead. A **required** item that is missing stops the stage (report it; do not build it here).

| Name this plan uses | Where | Required |
|---|---|---|
| `StashEntry`, `StashKind`, `PutAwayResult` | `src/lib/stash/types.ts` | yes |
| commands `stash_list`, `stash_put_away`, `stash_tag`, `stash_counts`, `stash_touch_opened`, `stash_entry_for_path`; event `stash-changed` | Rust, registered in `lib.rs` | yes |
| TS wrappers `stashList`, `stashPutAway`, `stashTag`, `stashCounts`, `stashTouchOpened`, `onStashChanged` | `src/lib/stash/ipc.ts` | no — Task 11 adds any that are missing, with the code given there |
| the ⌃T page handler and its registration in `App.svelte` (`window.addEventListener('keydown', <handler>, true)` after `onWindowCtrlTab`) | `src/lib/stash/stash-keys.ts`, `App.svelte` | yes |
| `StashState` holding the connection as `conn: Mutex<rusqlite::Connection>` | `src-tauri/src/stash/mod.rs` | yes (the field name may differ) |
| `crate::stash::emit_changed(&AppHandle, &str)` — the one place that emits `stash-changed` | `src-tauri/src/stash/` | yes (the name may differ) |
| `crate::stash::db::migrate(&mut Connection) -> Result<…>` | `src-tauri/src/stash/db.rs` | yes (may take `&Connection`) |
| an i18n key whose Russian value is «Без названия» (the untitled note title) | `locales/*/app.json` | no — Task 2 adds `stash.untitled` if there is none |
| `repo` of a note = the window project's **directory name** (`git_info::dir_name`), the same spelling Rust gives a file ref | stage 03 `stash_create_note` callers | yes — otherwise the repo chip cannot match notes and files alike |

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **The stash drawer lives inside `TabDrawer`'s root** (a sibling of `.drawer-wrap`), rendered whenever a `stash` store is passed, translated off-screen while closed. `TabDrawer` keeps the only `window` key listener, the focus trap (`insideDrawer`), the scrim and the drag machine; `StashDrawer` answers keys through `handle.key(e)`. | The spec: the stash «открывается … из дровера вкладок» and «закрытие дровера вкладок закрывает оба». One trap, one listener, one ghost: a second capture listener would fight the first over every key, and two drag machines could not hand a card across. The `display: contents` root (CLAUDE.md) means the new fixed-position drawer stacks in the page's context like the tabs drawer. |
| D2 | **Pure reducer + runes store.** `stash-state.ts` holds `{ open, focus, query, sort, repoChip, kb }` and every transition; `stash-store.svelte.ts` wraps it with entries, search indexes, counts, holders, the window repo and the pulse marks. | Testable without Svelte, like `drawer-state.ts`. The roadmap names only the store; the reducer is an addition (header table). |
| D3 | **Filter and sort on the client, over the whole list.** `stash_list` is paged to completion (`listAllEntries`, 500 per page) on every stash open and on `stash-changed` while open; the repo chip, `#tag` (prefix, repo included), quoted phrases and text are applied by `stashView`. Text matching reuses `drawer-filter.ts`'s `matchEntry` over the title and `indexText(entry.preview)`: title prefix, then title substring, then preview line. | Typing never waits for IPC. Stage 05 replaces only the text part with `stash_search`; the chip, sort and open-here exclusion stay here. |
| D4 | **Widths are computed in JS** (`drawerLayout(viewport, stashOpen)`) and applied with `style:width` to both wraps; the same call gives `narrow`, which also switches both drawers to compact cards (`compact || stashOpen && narrow`). ≥ 960: tabs `min(420, 52%)`, stash `min(400, 36%)`; < 960 with the stash open: each `min(normal, (vw − 40) / 2)`. | One formula for layout, compactness and the carousel band — a CSS copy would drift. Below 680 the window widens (D15), so the mockup's `max(320px, …)` floor is never needed; if widening is impossible the halves still never overlap. |
| D5 | **Focus is reducer state** (`'tabs' \| 'stash'`); DOM focus follows it (`listEl` / the stash list, `tabindex=-1`) through an effect, but key routing reads the store. A pointerdown in a drawer (capture phase) gives it the focus. | A click that blurs, or an inert element losing focus, cannot misroute keys. |
| D6 | **Key routing** in `TabDrawer.onKeyDown`, in this order: inputs that own their keys (`.notch-edit`, `.tag-edit`) → IME → ⌘G carousel → drag → **←/→** (no modifiers: → opens the stash or focuses it, ← focuses the tabs) → **stash focus: `stashHandle.key(e)`** → the existing `drawerKeyAction`. In the stash: Esc, ⌘L/⌘R/⌘U (changed/opened/kind), typing, Backspace, ↑↓, Enter. ⌘1…⌘9 keep picking the tabs drawer's visible cards (stash cards carry no ⌘n hint in the mockup). | Spec key table; mockup's keyboard block. |
| D7 | **Esc:** stash focused — clear its query, else close the stash alone (focus returns to the tabs). Tabs focused — the existing query → selection → close, and closing the tabs drawer closes the stash. | Spec «Esc … закрытие дровера вкладок закрывает оба»; mockup. |
| D8 | **Put away = one `stash_put_away` call, then `controller.closeTabs`** (the ⌘W path, so dirty checks, neighbour selection and ⌘⇧T apply). Tabs with no path (an empty new tab) are only closed. If the IPC fails nothing is closed and a `stash` error toast says why. A put-away merges the returned entries into the store at once (the cards appear on top without waiting for `stash-changed`). | «one transaction, animate»: the DB change is one call; the closes animate out of the tabs drawer (`out:collapse`) while the cards animate into the stash (`in:` on its slots). Reusing `closeTabs` keeps «background file tabs are always clean» and every close rule in one place. |
| D9 | **Open from the stash = `tab_request_move`**, one IPC that decides: this window holds it → activate that tab; another window holds it → Rust emits `tab-pull` to the holder, which runs its own `tabs.moveTabs([id], {kind:'window', label})` (the plan-05 move, dirty checks there), no «Перенесено» toast; nobody holds it → `tabs.openPath(path, {cursor: caret, topLine})`, then a drop position (`before`) is applied with `tabs.reorder`. `stash_touch_opened` after every success. A pull is watched for `PULL_WAIT_MS` (4 s): the tab arrives («… переехала из #N») or a toast offers «Перейти». A click or Enter opens and closes both drawers; a drag keeps them open. | Spec «Перенос»; mockup `openFromStash`. The holder, not the target, knows whether its tab may be left. |
| D10 | **«открыта в #N»** comes from `tab_holders(paths)` for every entry, refreshed on each list reload. Entries open **here** are filtered out by path against this window's tab list (live, reactive), and counted («· N во вкладках»). | `StashEntry` has no window; the registry does. Paths are the registry spelling on both sides (`path_norm`). |
| D11 | **Repo chip:** every stash open starts with the chip set to `window_repo` (refreshed on each open; if the repo arrives after the open and the chip was following it, the chip follows). `×` or ⌫ in an empty query removes it; `+ <repo>` puts it back. A window without a project shows neither. | Spec «Окно проекта открывает тайник уже отфильтрованным … снимается крестиком»; mockup `openStash`, `setRepoChip`. |
| D12 | **Pulse:** a put-away result with `created: false` pulses its card (after it arrives); an external `stash-changed` that raises `stashedAt` of a card that was on screen pulses it; tags new since the last load pop (`tag.new`). | Spec dedup «поднять его наверх»; mockup `stPulse`, `newTags`. `stash-changed` carries no ids, so external pulses come from a diff. |
| D13 | **«убрать из тайника» only on file refs**, through `stash_delete` (file branch: entry and its tags removed, file untouched). Note cards show no remove action in this stage; stage 06 adds «удалить» to them. | Scope; the roadmap's `stash_delete` semantics for files. |
| D14 | **Tag editing, minimal:** a `+ тег` chip opens an inline input (Enter adds, Esc/blur cancels; normalized: trimmed, `#` stripped, lower-case, spaces → `-`, ≤ 40 chars); `×` on a chip removes it; the repo chip (dashed) is not editable. A click on a chip filters by `#tag`. The input owns its keys like the notch's number input. | Scope «add/remove chip on a card»; mockup chip styles. |
| D15 | **Auto-widen:** on stash open, if `innerWidth < 680` and the window is not fullscreen (Split View is a fullscreen space), grow the inner width to `680 × page zoom` logical px, clamped to the monitor's work area, moving left first when the right edge would cross it; on stash close restore size (and position, if it was moved) **only if the window is still exactly as widened**. Toast «Окно раздвинулось…». | Spec «Уже 680px»; a restore after the human resized the window would undo their resize. |
| D16 | **Stash colour:** theme token `--color-stash: var(--color-link)` in every theme block (tunable per theme later); `--stash-tint`, `--stash-line`, `--stash-soft` mixed from it on `:root` in `src/styles/stash.css`, like the `tabs-*` tokens. | `src/lib/theme/CLAUDE.md`: a new colour is a token in every theme; the mockup derives everything from `--color-link`. |
| D17 | **Both drawers open veil the page like the carousel:** `main` gets the carousel's `blur(9px) saturate(.85)` (off under reduced motion), the scrim goes to `.82`. | Spec «размыта и затемнена так же сильно, как при карусели окон». |
| D18 | **⌃S** is a page handler (`ctrlSHandler`, capture phase, after ⌃T's), toggling the stash: from a closed drawer it opens both with the stash focused. Menu item «Тайник» (View → Tabs) with no accelerator does the same. **⌃T with the drawer open** puts away the ⇧-selection, else the card under the keyboard ring, else the active tab — and does nothing while the stash has the keys. The selection bar gets «В тайник» (mockup). | Spec keys; roadmap «Ctrl-only menu accelerator never fires»; mockup `stashByKey`, `#selStash`. |
| D19 | **The toast stack moves left of the open stash drawer** (`ToastStack` gets `right`; App passes `stash width + 16`). | The app's stack is bottom-right, exactly where the stash drawer is; the mockup's toast is centred and never collides. |
| D20 | **Carousel only over the page between the drawers:** with the stash open the band is `[tabs right, stash left]`, none at all in narrow mode (< 960) or when the band is under 60px. ⌘G with the stash open in narrow mode closes the stash first. | Spec «карусель здесь не появляется»; mockup `pageBounds`, `carouselFollow`. |

### Spec ↔ mockup conflicts found while planning

| Topic | Spec | Mockup | Chosen |
|---|---|---|---|
| Toast position | — | centred in the window, bottom | app's bottom-right stack, shifted left of the stash (D19) |
| File tab «in stash» mark on tab cards (`.in-stash`) | «Больше ничего («в тайнике» не пишем)» | small tray mark on file tabs in the stash | not added (spec wins; tab cards are stage 03's) |
| Note card «удалить» and the trash bar | stage 06 | present | omitted here (D13) |
| Sort id | roadmap `changed` | `edited` | `changed` (contract) |
| Stash sort persistence | «по умолчанию «изменение»» | a mode with `aria-pressed`, kept across opens | mode, kept for the window's life, default `changed` |
| Pulse on own put-away | «поднять его наверх» | arrive (+ pulse only for the other-window demo) | arrive, plus pulse when `created=false` (D12) |
| Carousel over the stash drawer | «между ними видна страница и может появиться карусель» | carousel between the drawers | same (D20) |

---

## File structure

**Rust (`src-tauri/src/`)**
- `tab_commands.rs` — modify: `TabHolder`, `holders_of`, `tab_holders`; `PullAnswer`, `PullRequest`, `pull_answer`, `tab_request_move`; `repo_of_window`, `window_repo`; tests.
- `stash/entries.rs` — modify: `remove_file_ref` + test.
- `stash/commands.rs` — modify: `stash_delete`.
- `menu.rs` — modify: `toggle_stash` item in View → Tabs.
- `menu_route.rs` — modify: test list gains `toggle_stash` (Focused, the default).
- `lib.rs` — modify: register four commands.

**Frontend (`src/`)**
- `lib/stash/drawer-width.ts` — **create**: widths, narrow, carousel band, widen plan.
- `lib/stash/stash-query.ts` — **create**: `#tag` / phrase / text parsing, tag normalization, matching.
- `lib/stash/stash-view.ts` — **create**: visible rows, sorts, `changedAt`, titles, paths, time labels.
- `lib/stash/stash-state.ts` — **create**: the drawer-pair reducer, key routing, sort-key table, pulse diff.
- `lib/stash/drop-target.ts` — **create**: which drop target a pointer is over.
- `lib/stash/stash-toast.ts` — **create**: the `stash` toast's payload type and its text.
- `lib/stash/types.ts`, `lib/stash/ipc.ts` — modify: counts/page/holder/pull types; wrappers for the new commands (+ any missing stage-03 wrapper); `listAllEntries`.
- `lib/stash/stash-store.svelte.ts` — **create**: the per-window store.
- `lib/stash/put-away.ts`, `lib/stash/open-from-stash.ts` — **create**: orchestration over injected deps.
- `lib/stash/window-widen.ts` — **create**: widen and restore the window.
- `lib/stash/stash-keys.ts` — modify: ⌃S.
- `lib/stash/icons.ts`, `lib/stash/StashIcon.svelte` — **create**.
- `lib/stash/StashCard.svelte`, `lib/stash/StashBar.svelte`, `lib/stash/StashDrawer.svelte` — **create**.
- `lib/tabs/TabDrawer.svelte` — modify: stash props, layout, render, focus, keys, drags, sel-bar button, carousel band.
- `lib/tabs/WindowCarousel.svelte` — modify: `right` prop.
- `lib/toasts.svelte.ts`, `lib/ToastStack.svelte` — modify: `stash` kind; `right` prop.
- `lib/tauri/events.ts` — modify: `onTabPull`, `MenuAction` `toggle_stash`.
- `App.svelte` — modify: store, listeners, handlers, ⌃S, ⌃T targets, menu, veil, widen, toast offset.
- `lib/theme/*.css` (8 files, 12 blocks) — modify: `--color-stash`; `styles/stash.css` — **create**; `lib/theme/CLAUDE.md` — modify.
- `src-tauri/capabilities/default.json` — modify: `core:window:allow-set-size`, `core:window:allow-set-position`.
- `locales/*/app.json`, `locales/*/native.json` — modify (6 languages each).
- Tests colocated: `*.test.ts` / `*.svelte.test.ts` next to each module.
- `CLAUDE.md` — modify (Task 25): architecture lines and gotchas.

---

## Task 0: Preconditions and baselines (no commit)

**Files:** none in the repo. Creates `$QA/preconditions.txt`, `$QA/substitutions.md`, `$QA/baselines.txt`.

- [ ] **Step 1: Branch and tree**

```bash
git rev-parse --abbrev-ref HEAD      # expect: feat/stash
git status --porcelain               # expect: empty
git log --oneline -5                 # expect: stage 03's last commit on top
test -d node_modules || npm install
QA="${CLAUDE_JOB_DIR:-/tmp}/stash04"; mkdir -p "$QA"
```

- [ ] **Step 2: Read what stages 02–03 built**

```bash
QA="${CLAUDE_JOB_DIR:-/tmp}/stash04"
{
  echo "## ipc.ts exports";          grep -nE "^export (async )?(function|const)" src/lib/stash/ipc.ts
  echo "## types.ts exports";        grep -nE "^export (interface|type)" src/lib/stash/types.ts
  echo "## stash-keys.ts exports";   grep -nE "^export (function|const)" src/lib/stash/stash-keys.ts
  echo "## stash-keys in App";       grep -n "stash-keys\|addEventListener('keydown'" src/App.svelte
  echo "## stash-changed listeners"; grep -rn "stash-changed\|onStashChanged" src/lib src/App.svelte
  echo "## untitled title key";      grep -n "Без названия" locales/ru/app.json
  echo "## stash toast kinds";       grep -n "kind: 'stash" src/lib/toasts.svelte.ts
  echo "## tray glyph path";         grep -rln "M2.5 9.5 4.2 3.5" src/lib
  echo "## StashState";              grep -n "pub struct StashState" -A10 src-tauri/src/stash/mod.rs
  echo "## emit";                    grep -rn "\"stash-changed\"" -B4 src-tauri/src/stash/
  echo "## db fns";                  grep -n "pub fn " src-tauri/src/stash/db.rs
  echo "## stash commands";          grep -n "pub async fn stash_\|pub fn stash_" src-tauri/src/stash/commands.rs
  echo "## registration";            grep -n "stash::commands::\|stash::" src-tauri/src/lib.rs
  echo "## note repo source";        grep -rn "stash_create_note\|stashCreateNote" src/lib src/App.svelte
} > "$QA/preconditions.txt" 2>&1
cat "$QA/preconditions.txt"
```

- [ ] **Step 3: Write the substitutions**

Compare the output with the «Preconditions» table. Write `$QA/substitutions.md` with one line per difference, `plan name → real name` (for example `state.conn.lock() → state.db.lock()`, `crate::stash::emit_changed → crate::stash::notify_changed`, `stash.untitled → note.untitled`). Rules:

- A **required** item missing → stop the stage and report exactly what is missing.
- A TS wrapper that exists under another name → record it; Task 11 must not add a second one.
- A wrapper that does not exist → Task 11 adds it (its code is there).
- A key with the value «Без названия» exists → record `stash.untitled → <that key>` and run Task 2's script with `--no-untitled`.
- Stage 03 already declares a toast kind named `stash` → record it and, in Task 21, merge this plan's `note` payload into that kind instead of adding a second one (the rendering is keyed on `payload.note.what`).
- A tray glyph path already exists in a stage-03 component → record the file; Task 15's `icons.ts` imports that constant instead of redefining the tray path if it is exported, else keeps its own copy (note the duplicate in the night report).
- Check how stage 03 fills `repo` for a new note (`stash_create_note` caller). If it is not the window project's directory name, stop and report: the chip would match files and never notes.

- [ ] **Step 4: Baselines**

```bash
QA="${CLAUDE_JOB_DIR:-/tmp}/stash04"
{
  echo "vitest:";  npx vitest run --dir src 2>&1 | grep -E "Test Files|Tests " 
  echo "cargo:";   CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result" 
  echo "clippy:";  CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "generated [0-9]+ warning" 
  echo "check:";   npm run check 2>&1 | tail -3
} | tee "$QA/baselines.txt"
```

Expected: everything green; the numbers are the baseline every later «expect» compares against ("baseline + N").

---

## Task 1: The stash colour — a theme token and its tints

**Files:**
- Create: `src/lib/stash/stash-tokens.test.ts`
- Create: `src/styles/stash.css`
- Modify: `src/lib/theme/light.css`, `dark.css`, `aurora-light.css`, `aurora-dark.css`, `blueprint.css` (2 blocks), `phosphor.css` (2), `ink.css` (2), `paper.css` (2)
- Modify: `src/App.svelte` (one import)
- Modify: `src/lib/theme/CLAUDE.md`

- [ ] **Step 1: Write the failing test**

`src/lib/stash/stash-tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_FAMILIES, concreteTheme } from '../theme-resolve';

/*
 * Stash stage 04 (D16): the stash drawer's colour is a theme token every
 * theme derives from its link colour, and the tints the mockup mixes are
 * mixed from that token. `theme-tokens.test.ts` already fails a theme that
 * lacks a token `light.css` defines; this pins the derivation itself.
 */

const THEME_DIR = fileURLToPath(new URL('../theme/', import.meta.url));
const STASH_CSS = fileURLToPath(new URL('../../styles/stash.css', import.meta.url));

function blocks(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(THEME_DIR).filter((n) => n.endsWith('.css'))) {
    const text = readFileSync(join(THEME_DIR, name), 'utf8');
    for (const m of text.matchAll(/:root\[data-theme='([\w-]+)'\]\s*\{([^{}]*)\}/g)) out.set(m[1], m[2]);
  }
  return out;
}

const THEMES = THEME_FAMILIES.flatMap((f) => [concreteTheme(f, 'light'), concreteTheme(f, 'dark')]);

describe('stash colour', () => {
  it.each(THEMES)('%s derives --color-stash from its link colour', (theme) => {
    expect(blocks().get(theme)).toMatch(/--color-stash:\s*var\(--color-link\);/);
  });

  it('the tints are mixed from the token on plain :root', () => {
    const css = readFileSync(STASH_CSS, 'utf8');
    for (const name of ['--stash-tint', '--stash-line', '--stash-soft']) {
      expect(css).toMatch(new RegExp(`${name}:\\s*color-mix\\(in oklab, var\\(--color-stash\\)`));
    }
  });
});
```

- [ ] **Step 2: Run it — it fails**

Run: `npx vitest run src/lib/stash/stash-tokens.test.ts`
Expected: FAIL — 12 theme cases (`--color-stash` missing) and `ENOENT … stash.css`.

- [ ] **Step 3: Add the token to every theme block**

```bash
perl -0pi -e 's/(\n([ \t]*)--color-link: [^;]+;)/$1\n$2--color-stash: var(--color-link);/g' src/lib/theme/*.css
grep -c -- "--color-stash: var(--color-link);" src/lib/theme/*.css
```

Expected counts: `light.css 1, dark.css 1, aurora-light.css 1, aurora-dark.css 1, blueprint.css 2, phosphor.css 2, ink.css 2, paper.css 2` (12 in total). If a file shows 0, its `--color-link` line is written differently: add the line by hand right after `--color-link` in each of its blocks.

- [ ] **Step 4: Create the tints**

`src/styles/stash.css`:

```css
/*
 * Stash stage 04: the stash drawer's own colour (spec «Дровер тайника»:
 * «своего цвета — производного от цвета ссылок темы»). `--color-stash` is a
 * theme token — every theme sets it to its `--color-link`, so one can be tuned
 * later without touching components; the tints are mixed from it here, on
 * plain :root like the `tabs-*` tokens. Values from the approved mockup
 * (docs/investigations/2026-09-26-stash-mockup/stash-drawers.html, tag
 * `stash-mockup-approved`). Custom properties resolve on :root, where the
 * theme block sets `--color-stash`, and are inherited already mixed.
 */
:root {
  --stash-tint: color-mix(in oklab, var(--color-stash) 6%, var(--bg-surface));
  --stash-line: color-mix(in oklab, var(--color-stash) 30%, var(--border));
  --stash-soft: color-mix(in oklab, var(--color-stash) 14%, transparent);
}
```

In `src/App.svelte`, right after `import './styles/tabs.css';` add:

```ts
  import './styles/stash.css';
```

- [ ] **Step 5: Document the token**

In `src/lib/theme/CLAUDE.md`, the token-set table row `| Accent | … |` becomes:

```markdown
| Accent | `--color-glow` (RGB triple), `--color-link`, `--color-checkbox`, `--color-stash` (the stash drawer; every theme sets it to `var(--color-link)` — change the value, not the components, to tune a theme) |
```

and after the paragraph that starts with `**\`tabs-*\` tokens**` add:

```markdown
**`stash-*` tokens** (`--stash-tint`, `--stash-line`, `--stash-soft`) are not theme tokens either: they live on plain `:root` in `src/styles/stash.css`, mixed from `--color-stash`. `src/lib/stash/stash-tokens.test.ts` pins both halves.
```

- [ ] **Step 6: Run the tests — they pass**

Run: `npx vitest run src/lib/stash/stash-tokens.test.ts src/lib/theme/theme-tokens.test.ts`
Expected: PASS (the token guard now also sees `--color-stash` in `light.css` and in every other theme).

- [ ] **Step 7: Commit**

```bash
git add src/lib/stash/stash-tokens.test.ts src/styles/stash.css src/lib/theme/*.css src/App.svelte src/lib/theme/CLAUDE.md
git commit -m "$(cat <<'EOF'
feat(stash): stash colour token derived from the theme link colour

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/stash/stash-tokens.test.ts src/styles/stash.css src/lib/theme/*.css src/App.svelte src/lib/theme/CLAUDE.md
```

---

## Task 2: Strings for the drawer, the cards and the toasts

**Files:**
- Create (outside the repo): `$QA/add-strings.mjs`
- Create: `src/lib/stash/stash-strings.test.ts`
- Modify: `locales/{en,es,de,fr,ru,zh}/app.json`, `locales/{en,es,de,fr,ru,zh}/native.json`

Russian is authoritative (the mockup's copy); English uses "stash". es/de/fr/zh get the English text until translated — Task 25 lists that in the night report. The locale files group keys with blank lines, so the script appends one new group before the closing brace instead of re-serializing the file.

- [ ] **Step 1: Write the failing test**

`src/lib/stash/stash-strings.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { installCatalog, plural, t } from '../i18n';

afterEach(() => installCatalog('en'));

describe('stash strings', () => {
  it('Russian carries the mockup copy', () => {
    installCatalog('ru');
    expect(t('stash.bar.button')).toBe('Тайник');
    expect(t('stash.bar.drop')).toBe('Отложить в тайник');
    expect(t('stash.drawer.type_hint')).toBe('печатайте · #тег');
    expect(t('stash.card.open_in_note', { n: 19 })).toBe('открыта в #19');
    expect(plural(3, 'stash.when.days_ago')).toBe('3 дня назад');
    expect(t('toast.stash.widened')).toBe('Окно раздвинулось, чтобы тайник встал рядом');
  });

  it('English says "stash"', () => {
    installCatalog('en');
    expect(t('stash.drawer.title')).toBe('Stash');
    expect(t('tabs.selection.to_stash')).toBe('To stash');
  });
});
```

- [ ] **Step 2: Run it — it fails**

Run: `npx vitest run src/lib/stash/stash-strings.test.ts`
Expected: FAIL (`t` returns the bare keys).

- [ ] **Step 3: Write the script**

`$QA/add-strings.mjs` (run from the repo root):

```js
// Stash stage 04: append the drawer's strings to every locale as one new group.
// `--no-untitled`: stage 03 already has the «Без названия» key (Task 0 Step 3).
import { readFileSync, writeFileSync } from 'node:fs';

const APP_RU = {
  'stash.untitled': 'Без названия',
  'stash.bar.button': 'Тайник',
  'stash.bar.button_title': 'Тайник — второй ящик справа (→)',
  'stash.bar.today': 'отложено сегодня {n}',
  'stash.bar.key_title': '→ открывает тайник',
  'stash.bar.drop': 'Отложить в тайник',
  'stash.drawer.title': 'Тайник',
  'stash.drawer.type_hint': 'печатайте · #тег',
  'stash.drawer.focus_tabs': 'вкладки',
  'stash.drawer.focus_stash': 'тайник',
  'stash.drawer.sort_changed': 'изменение',
  'stash.drawer.sort_changed_title': 'Недавно изменённые сверху',
  'stash.drawer.sort_opened': 'открытие',
  'stash.drawer.sort_opened_title': 'Недавно открытые сверху',
  'stash.drawer.sort_kind': 'тип',
  'stash.drawer.sort_kind_title': 'Сначала заметки, потом файлы',
  'stash.drawer.empty_open_here': 'Всё с этим тегом уже открыто вкладками',
  'stash.drawer.empty_repo': 'С тегом #{repo} в тайнике пусто',
  'stash.drawer.empty_all': 'В тайнике пусто',
  'stash.filter.chip_title': 'Окно #{n} привязано к репо {repo} — тайник открыт с этим фильтром',
  'stash.filter.remove': 'Снять фильтр по репо',
  'stash.filter.remove_title': 'Показать весь тайник (⌫ в пустом поиске)',
  'stash.filter.add_title': 'Вернуть фильтр по репо окна',
  'stash.filter.note_repo': 'репо окна · {shown} из {total}',
  'stash.filter.note_all': 'весь тайник · {shown} из {total}',
  'stash.filter.in_tabs': '· {n} во вкладках',
  'stash.foot.drag': 'тяните во вкладки',
  'stash.foot.drag_tail': '— открыть',
  'stash.foot.tag': '#тег',
  'stash.foot.tag_tail': '— фильтр',
  'stash.foot.keys': '← →',
  'stash.foot.keys_tail': '— ящики',
  'stash.card.kind_note': 'Заметка — текст хранит couplet',
  'stash.card.kind_file': 'Ссылка на файл — сам файл лежит на своём месте',
  'stash.card.open_in_note': 'открыта в #{n}',
  'stash.card.open_in_file': 'открыт в #{n}',
  'stash.card.open_in_title': 'Открыт вкладкой в другом окне — откроется здесь, переехав оттуда',
  'stash.card.remove_file': 'убрать из тайника',
  'stash.card.remove_file_title': 'Файл останется на месте — уберётся только ссылка',
  'stash.card.away': 'отложено {when}',
  'stash.card.note_meta': 'заметка · {when}',
  'stash.card.repo_tag_title': 'Тег репо — ставится сам',
  'stash.card.tag_title': 'Фильтр по #{tag}',
  'stash.card.tag_remove': 'Снять тег #{tag}',
  'stash.card.tag_add': '+ тег',
  'stash.card.tag_add_title': 'Добавить тег',
  'stash.card.tag_placeholder': 'тег',
  'stash.when.now': 'только что',
  'stash.when.today': 'сегодня {time}',
  'stash.when.yesterday': 'вчера',
  'stash.when.days_ago.one': '{count} день назад',
  'stash.when.days_ago.few': '{count} дня назад',
  'stash.when.days_ago.many': '{count} дней назад',
  'stash.when.days_ago.other': '{count} дней назад',
  'stash.ghost.to_stash': 'В тайник',
  'stash.ghost.open': 'Открыть вкладкой',
  'stash.ghost.note_meta': 'заметка из тайника',
  'tabs.selection.to_stash': 'В тайник',
  'tabs.selection.to_stash_title': 'Отложить выбранные в тайник (⌃T)',
  'toast.stash.put_one': '{title} → тайник',
  'toast.stash.put_one_tail': '· отложено',
  'toast.stash.put_note': 'Заметка {title} → тайник',
  'toast.stash.put_note_tail': '· отложена',
  'toast.stash.put_dup_tail': '· запись уже была — вторая не создана',
  'toast.stash.put_many': 'Отложено в тайник: {count}',
  'toast.stash.put_many_dup': '· для {dup} запись уже была — дублей нет',
  'toast.stash.hidden.one': '· скрыт фильтром #{repo}',
  'toast.stash.hidden.few': '· скрыты фильтром #{repo}',
  'toast.stash.hidden.many': '· скрыты фильтром #{repo}',
  'toast.stash.hidden.other': '· скрыты фильтром #{repo}',
  'toast.stash.only_empty': 'Пустая заметка закрыта',
  'toast.stash.only_empty_tail': '· хранить нечего',
  'toast.stash.empty_too': '· пустая заметка просто закрыта',
  'toast.stash.opened_note': '{title} открыта вкладкой',
  'toast.stash.opened_file': '{title} открыт вкладкой',
  'toast.stash.from_stash': '· из тайника',
  'toast.stash.moved_note': '· переехала из #{n}',
  'toast.stash.moved_file': '· переехал из #{n}',
  'toast.stash.removed': '{title} убран из тайника',
  'toast.stash.removed_tail': '· файл остался на месте',
  'toast.stash.widened': 'Окно раздвинулось, чтобы тайник встал рядом',
  'toast.stash.widened_tail': '· вернётся, когда тайник закроется',
  'toast.stash.pull_failed': 'Не получилось перенести из #{n}',
  'toast.stash.go': 'Перейти',
  'toast.stash.error': 'Тайник не ответил',
};

const APP_EN = {
  'stash.untitled': 'Untitled',
  'stash.bar.button': 'Stash',
  'stash.bar.button_title': 'Stash — the second drawer, on the right (→)',
  'stash.bar.today': 'put away today {n}',
  'stash.bar.key_title': '→ opens the stash',
  'stash.bar.drop': 'Put away in the stash',
  'stash.drawer.title': 'Stash',
  'stash.drawer.type_hint': 'type · #tag',
  'stash.drawer.focus_tabs': 'tabs',
  'stash.drawer.focus_stash': 'stash',
  'stash.drawer.sort_changed': 'changed',
  'stash.drawer.sort_changed_title': 'Recently changed first',
  'stash.drawer.sort_opened': 'opened',
  'stash.drawer.sort_opened_title': 'Recently opened first',
  'stash.drawer.sort_kind': 'kind',
  'stash.drawer.sort_kind_title': 'Notes first, then files',
  'stash.drawer.empty_open_here': 'Everything with this tag is already open as tabs',
  'stash.drawer.empty_repo': 'Nothing tagged #{repo} in the stash',
  'stash.drawer.empty_all': 'The stash is empty',
  'stash.filter.chip_title': 'Window #{n} is bound to the {repo} repo — the stash opens with this filter',
  'stash.filter.remove': 'Remove the repo filter',
  'stash.filter.remove_title': 'Show the whole stash (⌫ with an empty search)',
  'stash.filter.add_title': "Filter by the window's repo again",
  'stash.filter.note_repo': "window's repo · {shown} of {total}",
  'stash.filter.note_all': 'whole stash · {shown} of {total}',
  'stash.filter.in_tabs': '· {n} in tabs',
  'stash.foot.drag': 'drag to the tabs',
  'stash.foot.drag_tail': 'to open',
  'stash.foot.tag': '#tag',
  'stash.foot.tag_tail': 'to filter',
  'stash.foot.keys': '← →',
  'stash.foot.keys_tail': 'between drawers',
  'stash.card.kind_note': 'Note — couplet keeps the text',
  'stash.card.kind_file': 'File link — the file stays where it is',
  'stash.card.open_in_note': 'open in #{n}',
  'stash.card.open_in_file': 'open in #{n}',
  'stash.card.open_in_title': 'Open as a tab in another window — opening it here moves it',
  'stash.card.remove_file': 'remove from stash',
  'stash.card.remove_file_title': 'The file stays where it is — only the link goes',
  'stash.card.away': 'put away {when}',
  'stash.card.note_meta': 'note · {when}',
  'stash.card.repo_tag_title': 'Repo tag — set automatically',
  'stash.card.tag_title': 'Filter by #{tag}',
  'stash.card.tag_remove': 'Remove tag #{tag}',
  'stash.card.tag_add': '+ tag',
  'stash.card.tag_add_title': 'Add a tag',
  'stash.card.tag_placeholder': 'tag',
  'stash.when.now': 'just now',
  'stash.when.today': 'today {time}',
  'stash.when.yesterday': 'yesterday',
  'stash.when.days_ago.one': '{count} day ago',
  'stash.when.days_ago.few': '{count} days ago',
  'stash.when.days_ago.many': '{count} days ago',
  'stash.when.days_ago.other': '{count} days ago',
  'stash.ghost.to_stash': 'To the stash',
  'stash.ghost.open': 'Open as a tab',
  'stash.ghost.note_meta': 'note from the stash',
  'tabs.selection.to_stash': 'To stash',
  'tabs.selection.to_stash_title': 'Put the selected tabs away in the stash (⌃T)',
  'toast.stash.put_one': '{title} → stash',
  'toast.stash.put_one_tail': '· put away',
  'toast.stash.put_note': 'Note {title} → stash',
  'toast.stash.put_note_tail': '· put away',
  'toast.stash.put_dup_tail': '· it was already there — no second entry',
  'toast.stash.put_many': 'Put away in the stash: {count}',
  'toast.stash.put_many_dup': '· {dup} already there — no duplicates',
  'toast.stash.hidden.one': '· hidden by the #{repo} filter',
  'toast.stash.hidden.few': '· hidden by the #{repo} filter',
  'toast.stash.hidden.many': '· hidden by the #{repo} filter',
  'toast.stash.hidden.other': '· hidden by the #{repo} filter',
  'toast.stash.only_empty': 'Empty note closed',
  'toast.stash.only_empty_tail': '· nothing to keep',
  'toast.stash.empty_too': '· the empty note was just closed',
  'toast.stash.opened_note': '{title} opened as a tab',
  'toast.stash.opened_file': '{title} opened as a tab',
  'toast.stash.from_stash': '· from the stash',
  'toast.stash.moved_note': '· moved from #{n}',
  'toast.stash.moved_file': '· moved from #{n}',
  'toast.stash.removed': '{title} removed from the stash',
  'toast.stash.removed_tail': '· the file is still where it was',
  'toast.stash.widened': 'The window widened to fit the stash beside the tabs',
  'toast.stash.widened_tail': '· it goes back when the stash closes',
  'toast.stash.pull_failed': 'Could not move it from #{n}',
  'toast.stash.go': 'Go there',
  'toast.stash.error': 'The stash did not answer',
};

const NATIVE_RU = { 'menu.view.toggle_stash': 'Тайник' };
const NATIVE_EN = { 'menu.view.toggle_stash': 'Stash' };

const noUntitled = process.argv.includes('--no-untitled');

function append(path, add) {
  const text = readFileSync(path, 'utf8');
  const current = JSON.parse(text);
  if (!/\n}\n?$/.test(text)) throw new Error(`${path}: does not end with "}"`);
  const lines = [];
  for (const [key, value] of Object.entries(add)) {
    if (noUntitled && key === 'stash.untitled') continue;
    if (key in current) throw new Error(`${path}: ${key} already exists`);
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  }
  const next = text.replace(/\n}\n?$/, `,\n\n${lines.join(',\n')}\n}\n`);
  JSON.parse(next); // still valid JSON
  writeFileSync(path, next);
}

for (const lang of ['en', 'es', 'de', 'fr', 'ru', 'zh']) {
  append(`locales/${lang}/app.json`, lang === 'ru' ? APP_RU : APP_EN);
  append(`locales/${lang}/native.json`, lang === 'ru' ? NATIVE_RU : NATIVE_EN);
}
console.log('stash strings added to 6 locales');
```

- [ ] **Step 4: Run the script**

```bash
QA="${CLAUDE_JOB_DIR:-/tmp}/stash04"
node "$QA/add-strings.mjs"            # or: node "$QA/add-strings.mjs" --no-untitled  (Task 0 Step 3)
git diff --stat -- locales
```

Expected: `stash strings added to 6 locales`; 12 files changed, appended lines only.

- [ ] **Step 5: Run the tests — they pass**

Run: `npx vitest run src/lib/stash/stash-strings.test.ts src/lib/i18n.test.ts`
Expected: PASS (the catalog-completeness test in `i18n.test.ts` sees the same key set in all six `app.json`). If `--no-untitled` was used, the new test still passes: it does not read `stash.untitled`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/stash/stash-strings.test.ts locales/*/app.json locales/*/native.json
git commit -m "$(cat <<'EOF'
feat(stash): strings for the stash drawer, cards and toasts (ru authoritative, en elsewhere)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/stash/stash-strings.test.ts locales/*/app.json locales/*/native.json
```

---

## Task 3: Drawer widths, the carousel band and the widen plan (pure)

**Files:**
- Create: `src/lib/stash/drawer-width.ts`
- Create: `src/lib/stash/drawer-width.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/stash/drawer-width.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DRAWER_GAP,
  MIN_BOTH,
  NARROW_AT,
  drawerLayout,
  needsWiden,
  pageBand,
  planWiden,
  stillWidened,
} from './drawer-width';

describe('drawerLayout', () => {
  it('uses the normal widths in a wide window, stash open or not', () => {
    expect(drawerLayout(1180, false)).toEqual({ tabs: 420, stash: 400, narrow: false });
    expect(drawerLayout(1180, true)).toEqual({ tabs: 420, stash: 400, narrow: false });
  });

  it('keeps the fractions at the narrow threshold', () => {
    const l = drawerLayout(NARROW_AT, true);
    expect(l.narrow).toBe(false);
    expect(l.tabs).toBe(420);
    expect(l.stash).toBeCloseTo(345.6, 5);
  });

  it('squeezes both to (width − 40) / 2 below 960 while the stash is open', () => {
    expect(drawerLayout(900, true)).toEqual({ tabs: 420, stash: 400, narrow: true });
    expect(drawerLayout(720, true)).toEqual({ tabs: 340, stash: 340, narrow: true });
    expect(drawerLayout(MIN_BOTH, true)).toEqual({ tabs: 320, stash: 320, narrow: true });
  });

  it('with the stash closed a narrow window keeps the tabs fraction', () => {
    expect(drawerLayout(800, false)).toEqual({ tabs: 416, stash: 288, narrow: true });
  });

  it('never lets the two drawers overlap', () => {
    for (let vw = 300; vw <= 2000; vw += 7) {
      const l = drawerLayout(vw, true);
      expect(l.tabs + l.stash + (l.narrow ? DRAWER_GAP : 0), `vw ${vw}`).toBeLessThanOrEqual(vw + 1e-9);
    }
  });
});

describe('needsWiden', () => {
  it('is true only below 680 px', () => {
    expect(MIN_BOTH).toBe(680);
    expect(needsWiden(679)).toBe(true);
    expect(needsWiden(680)).toBe(false);
    expect(needsWiden(0)).toBe(false);
  });
});

describe('pageBand', () => {
  it('is the page right of the tabs drawer, or between the drawers', () => {
    expect(pageBand(420, null, 1180, false)).toEqual({ left: 420, right: 1180 });
    expect(pageBand(420, 780, 1180, false)).toEqual({ left: 420, right: 780 });
  });

  it('is gone between squeezed drawers and when under 60 px', () => {
    expect(pageBand(340, 380, 720, true)).toBeNull();
    expect(pageBand(420, 470, 1000, false)).toBeNull();
  });
});

describe('planWiden', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };

  it('grows the inner width to 680 and stays put when it fits', () => {
    expect(
      planWiden({ viewport: 560, inner: { width: 560, height: 700 }, outer: { x: 100, y: 50, width: 560, height: 728 }, workArea })
    ).toEqual({ inner: { width: 680, height: 700 }, position: null });
  });

  it('moves left when the right edge would cross the work area', () => {
    expect(
      planWiden({ viewport: 560, inner: { width: 560, height: 700 }, outer: { x: 900, y: 50, width: 560, height: 728 }, workArea })
    ).toEqual({ inner: { width: 680, height: 700 }, position: { x: 760, y: 50 } });
  });

  it('counts the page zoom: 680 CSS px at 125 % is 850 logical px', () => {
    expect(
      planWiden({ viewport: 480, inner: { width: 600, height: 700 }, outer: { x: 0, y: 50, width: 600, height: 728 }, workArea })
    ).toEqual({ inner: { width: 850, height: 700 }, position: null });
  });

  it('never grows past the work area', () => {
    const small = { x: 0, y: 25, width: 640, height: 875 };
    expect(
      planWiden({ viewport: 560, inner: { width: 560, height: 700 }, outer: { x: 40, y: 50, width: 560, height: 728 }, workArea: small })
    ).toEqual({ inner: { width: 640, height: 700 }, position: { x: 0, y: 50 } });
  });

  it('does nothing for a window already wide enough', () => {
    expect(
      planWiden({ viewport: 700, inner: { width: 700, height: 700 }, outer: { x: 0, y: 50, width: 700, height: 728 }, workArea })
    ).toBeNull();
  });
});

describe('stillWidened', () => {
  it('allows a pixel of rounding, not a resize', () => {
    expect(stillWidened({ width: 680.5, height: 700 }, { width: 680, height: 700 })).toBe(true);
    expect(stillWidened({ width: 700, height: 700 }, { width: 680, height: 700 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — it fails**

Run: `npx vitest run src/lib/stash/drawer-width.test.ts`
Expected: FAIL — `Failed to resolve import "./drawer-width"`.

- [ ] **Step 3: Implement**

`src/lib/stash/drawer-width.ts`:

```ts
/**
 * Stash stage 04: how wide the two drawers are, and when the window must widen
 * for them (spec «Оба дровера вместе → Никогда не перекрываются»; mockup
 * `NARROW_AT`, `MIN_BOTH`). Pure — `TabDrawer` applies the widths with
 * `style:width`, `window-widen.ts` moves the window. All widths in CSS px.
 */

/** Below this viewport width both drawers squeeze side by side with compact cards. */
export const NARROW_AT = 960;
/** The gap between squeezed drawers: the tabs notch shows in it. */
export const DRAWER_GAP = 40;
/** A squeezed drawer is not narrower than this while the window can still widen. */
export const DRAWER_MIN = 320;
/** 2 × 320 + 40: below this the window widens while the stash is open. */
export const MIN_BOTH = DRAWER_MIN * 2 + DRAWER_GAP;
export const TABS_WIDTH = 420;
export const TABS_FRACTION = 0.52;
export const STASH_WIDTH = 400;
export const STASH_FRACTION = 0.36;
/** Less page than this between the drawers is no room for the window carousel (mockup). */
export const CAROUSEL_MIN_BAND = 60;

export interface DrawerLayout {
  tabs: number;
  stash: number;
  /** Below `NARROW_AT`: with the stash open, both drawers squeeze and cards go compact. */
  narrow: boolean;
}

/**
 * Wide: tabs `min(420, 52%)`, stash `min(400, 36%)` — the page and the carousel
 * show between them. Narrow with the stash open: each `min(normal, (vw − 40) / 2)`.
 * The mockup's `max(320px, …)` floor is left out on purpose: below 680 the
 * window widens (`planWiden`), and if it cannot, halves that never overlap beat
 * 320 px that do.
 */
export function drawerLayout(viewport: number, stashOpen: boolean): DrawerLayout {
  const narrow = viewport < NARROW_AT;
  if (stashOpen && narrow) {
    const half = Math.max(0, (viewport - DRAWER_GAP) / 2);
    return { tabs: Math.min(TABS_WIDTH, half), stash: Math.min(STASH_WIDTH, half), narrow };
  }
  return {
    tabs: Math.min(TABS_WIDTH, viewport * TABS_FRACTION),
    stash: Math.min(STASH_WIDTH, viewport * STASH_FRACTION),
    narrow,
  };
}

export function needsWiden(viewport: number): boolean {
  return viewport > 0 && viewport < MIN_BOTH;
}

export interface Band {
  left: number;
  right: number;
}

/**
 * The page a dragged tab card can open the window carousel over: right of the
 * tabs drawer, left of the stash drawer when it is open. None between squeezed
 * drawers (spec: «карусель здесь не появляется») or when it is a sliver.
 */
export function pageBand(tabsRight: number, stashLeft: number | null, viewport: number, narrow: boolean): Band | null {
  if (stashLeft !== null && narrow) return null;
  const right = stashLeft ?? viewport;
  return right - tabsRight > CAROUSEL_MIN_BAND ? { left: tabsRight, right } : null;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export interface WidenInput {
  /** `window.innerWidth`, CSS px (page zoom applied). */
  viewport: number;
  /** Inner size, logical px. */
  inner: Size;
  /** Outer frame, logical px. */
  outer: Rect;
  /** The monitor's work area (no menu bar, no Dock), logical px. */
  workArea: Rect;
}

export interface WidenPlan {
  /** The new inner size, logical px (`setSize` sets the inner size). */
  inner: Size;
  /** Where the outer frame moves first, or `null` to stay. */
  position: { x: number; y: number } | null;
}

/**
 * The window grows to fit both drawers: `MIN_BOTH` CSS px of content, i.e.
 * `MIN_BOTH × zoom` logical px (zoom = logical inner width / CSS width, so a
 * 125 % page zoom is counted), clamped to the work area, and moved left when
 * its right edge would cross it. `null`: nothing to do.
 */
export function planWiden(input: WidenInput): WidenPlan | null {
  const { viewport, inner, outer, workArea } = input;
  if (!needsWiden(viewport) || inner.width <= 0) return null;
  const zoom = inner.width / viewport;
  const frame = Math.max(0, outer.width - inner.width);
  const outerWidth = Math.min(Math.ceil(MIN_BOTH * zoom) + frame, workArea.width);
  const innerWidth = outerWidth - frame;
  if (innerWidth <= inner.width) return null;
  const right = workArea.x + workArea.width;
  const x = outer.x + outerWidth > right ? Math.max(workArea.x, right - outerWidth) : outer.x;
  return { inner: { width: innerWidth, height: inner.height }, position: x === outer.x ? null : { x, y: outer.y } };
}

/** The window is still as it was widened — so putting it back undoes no resize of the human's. */
export function stillWidened(current: Size, widened: Size): boolean {
  return Math.abs(current.width - widened.width) <= 1 && Math.abs(current.height - widened.height) <= 1;
}
```

- [ ] **Step 4: Run it — it passes**

Run: `npx vitest run src/lib/stash/drawer-width.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stash/drawer-width.ts src/lib/stash/drawer-width.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): drawer widths, carousel band and window widen plan as pure functions

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/stash/drawer-width.ts src/lib/stash/drawer-width.test.ts
```

---

## Task 4: The stash query — `#tag`, phrases, text (pure)

**Files:**
- Create: `src/lib/stash/stash-query.ts`
- Create: `src/lib/stash/stash-query.test.ts`

Stage 05 keeps `parseStashQuery` and `normalizeTag` and replaces `matchStash`'s text part with `stash_search` hits.

- [ ] **Step 1: Write the failing test**

`src/lib/stash/stash-query.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { indexText } from '../tabs/drawer-filter';
import { TAG_MAX, matchStash, normalizeTag, parseStashQuery, type StashCandidate } from './stash-query';

describe('normalizeTag', () => {
  it('trims, drops #, lower-cases and joins words with -', () => {
    expect(normalizeTag('  #Deploy Plan ')).toBe('deploy-plan');
    expect(normalizeTag('##Инфра')).toBe('инфра');
  });

  it('refuses an empty tag and cuts a long one', () => {
    expect(normalizeTag('#')).toBeNull();
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('x'.repeat(100))).toHaveLength(TAG_MAX);
  });
});

describe('parseStashQuery', () => {
  it('splits #tags from text', () => {
    expect(parseStashQuery('#Infra  sast  #ci')).toEqual({ tags: ['infra', 'ci'], text: 'sast' });
  });

  it('keeps a quoted phrase as text', () => {
    expect(parseStashQuery('"HDMI переговорка" #infra')).toEqual({ tags: ['infra'], text: 'hdmi переговорка' });
    expect(parseStashQuery('"unclosed phrase')).toEqual({ tags: [], text: 'unclosed phrase' });
  });

  it('a lone # is no tag yet', () => {
    expect(parseStashQuery('#')).toEqual({ tags: [], text: '' });
  });
});

describe('matchStash', () => {
  const note: StashCandidate = {
    title: 'Вопросы к AppSec по SAST',
    repo: 'shelf-design',
    tags: ['infra'],
    index: indexText('# Вопросы к AppSec по SAST\n- semgrep или CodeQL — кто поддерживает правила?'),
  };

  it('no text: passes when every tag matches the start of a tag or the repo', () => {
    expect(matchStash(note, parseStashQuery(''))).toEqual({ rank: 0 });
    expect(matchStash(note, parseStashQuery('#inf'))).toEqual({ rank: 0 });
    expect(matchStash(note, parseStashQuery('#shelf'))).toEqual({ rank: 0 });
    expect(matchStash(note, parseStashQuery('#ideas'))).toBeNull();
  });

  it('ranks a title prefix, a title substring, then a text line', () => {
    expect(matchStash(note, parseStashQuery('вопр'))).toEqual({ rank: 0 });
    expect(matchStash(note, parseStashQuery('sast'))).toEqual({ rank: 1 });
    expect(matchStash(note, parseStashQuery('codeql'))).toEqual({
      rank: 2,
      line: 'semgrep или CodeQL — кто поддерживает правила?',
    });
    expect(matchStash(note, parseStashQuery('kubernetes'))).toBeNull();
  });

  it('matches without an index by title only', () => {
    expect(matchStash({ ...note, index: null }, parseStashQuery('codeql'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — it fails**

Run: `npx vitest run src/lib/stash/stash-query.test.ts`
Expected: FAIL — cannot resolve `./stash-query`.

- [ ] **Step 3: Implement**

`src/lib/stash/stash-query.ts`:

```ts
/**
 * The stash drawer's query (spec «Поиск → Язык запроса»: text, `#тег`, a
 * phrase in quotes — combined freely). Stage 04 matches by substring over the
 * title and the entry's preview, reusing the tabs drawer's ranking; stage 05
 * swaps the text part for `stash_search` (FTS5 trigram) and keeps the parsing.
 */
import { matchEntry, type Match, type SearchIndex } from '../tabs/drawer-filter';

export const TAG_MAX = 40;

export interface StashQuery {
  /** Normalized tags (`normalizeTag`); each must match the start of a tag or the repo. */
  tags: string[];
  /** Everything else, lower-cased, single-spaced; phrases lose their quotes. */
  text: string;
}

/** A tag as the stash stores it: trimmed, no `#`, lower-case, inner spaces as `-`. `null`: empty. */
export function normalizeTag(raw: string): string | null {
  const tag = raw
    .trim()
    .replace(/^#+/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .slice(0, TAG_MAX);
  return tag || null;
}

/** A phrase (closing quote optional — it is being typed) or a bare word. */
const TOKEN = /"([^"]*)"?|(\S+)/g;

export function parseStashQuery(raw: string): StashQuery {
  const tags: string[] = [];
  const words: string[] = [];
  for (const m of raw.matchAll(TOKEN)) {
    if (m[1] !== undefined) {
      const phrase = m[1].trim();
      if (phrase) words.push(phrase);
      continue;
    }
    const word = m[2];
    if (word.startsWith('#')) {
      const tag = normalizeTag(word);
      if (tag) tags.push(tag);
    } else {
      words.push(word);
    }
  }
  return { tags, text: words.join(' ').toLowerCase() };
}

export interface StashCandidate {
  title: string;
  repo: string | null;
  tags: readonly string[];
  /** `indexText(entry.preview)`; `null`: title only. */
  index: SearchIndex | null;
}

/**
 * `null`: filtered out. With no text every candidate that passes the tags is
 * `{ rank: 0 }` (the sort decides); with text, the tabs drawer's ranks: title
 * prefix 0, title substring 1, a line of the preview 2 (with that line).
 */
export function matchStash(c: StashCandidate, q: StashQuery): Match | null {
  const all = c.repo ? [c.repo, ...c.tags] : c.tags;
  for (const tag of q.tags) {
    if (!all.some((t) => t.toLowerCase().startsWith(tag))) return null;
  }
  if (!q.text) return { rank: 0 };
  return matchEntry({ id: '', name: c.title, index: c.index }, q.text);
}
```

- [ ] **Step 4: Run it — it passes**

Run: `npx vitest run src/lib/stash/stash-query.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stash/stash-query.ts src/lib/stash/stash-query.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): query parsing (#tag, phrases, text) and substring matching

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/stash/stash-query.ts src/lib/stash/stash-query.test.ts
```

---

## Task 5: The visible list, sorts and time labels (pure)

**Files:**
- Create: `src/lib/stash/stash-view.ts`
- Create: `src/lib/stash/stash-view.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/stash/stash-view.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { indexText, type SearchIndex } from '../tabs/drawer-filter';
import { installCatalog } from '../i18n';
import type { StashEntry } from './types';
import {
  changedAt,
  dropFirstLine,
  entryTitle,
  formatWhen,
  repoRelativePath,
  stashView,
  whenOf,
  type StashSort,
} from './stash-view';

const NOW = new Date(2026, 8, 26, 10, 30).getTime();
const MIN = 60_000;

function entry(id: string, over: Partial<StashEntry> = {}): StashEntry {
  return {
    id,
    kind: 'note',
    path: `/n/${id}.md`,
    title: id,
    repo: null,
    branch: null,
    tags: [],
    createdAt: 0,
    modifiedAt: NOW - 100 * MIN,
    stashedAt: null,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: '',
    ...over,
  };
}

function indexes(entries: StashEntry[]): Map<string, SearchIndex> {
  return new Map(entries.map((e) => [e.id, indexText(e.preview)]));
}

function ids(
  entries: StashEntry[],
  over: { sort?: StashSort; query?: string; repoChip?: string | null; openHere?: string[] } = {}
): string[] {
  return stashView({
    entries,
    indexes: indexes(entries),
    openHere: new Set(over.openHere ?? []),
    repoChip: over.repoChip ?? null,
    query: over.query ?? '',
    sort: over.sort ?? 'changed',
    untitled: 'Untitled',
  }).rows.map((r) => r.entry.id);
}

afterEach(() => installCatalog('en'));

describe('changedAt', () => {
  it('is the later of the last edit and the last put-away', () => {
    expect(changedAt(entry('a', { modifiedAt: 5, stashedAt: 9 }))).toBe(9);
    expect(changedAt(entry('a', { modifiedAt: 5, stashedAt: null }))).toBe(5);
  });
});

describe('stashView', () => {
  const a = entry('a', { modifiedAt: NOW - 500 * MIN, stashedAt: NOW - 10 * MIN, openedAt: NOW - 400 * MIN });
  const b = entry('b', { modifiedAt: NOW - 20 * MIN, openedAt: NOW - 5 * MIN, kind: 'file', repo: 'infra' });
  const c = entry('c', { modifiedAt: NOW - 300 * MIN, repo: 'infra', tags: ['ops'] });

  it('sorts by change by default, most recent first', () => {
    expect(ids([c, b, a])).toEqual(['a', 'b', 'c']);
  });

  it('sorts by opening, never-opened last, ties by change', () => {
    expect(ids([c, b, a], { sort: 'opened' })).toEqual(['b', 'a', 'c']);
  });

  it('sorts notes first, then files, each by change', () => {
    expect(ids([c, b, a], { sort: 'kind' })).toEqual(['a', 'c', 'b']);
  });

  it('the repo chip keeps only that repo', () => {
    expect(ids([a, b, c], { repoChip: 'infra' })).toEqual(['b', 'c']);
  });

  it('hides what is open as a tab here, and counts it', () => {
    const view = stashView({
      entries: [a, b, c],
      indexes: indexes([a, b, c]),
      openHere: new Set(['/n/b.md']),
      repoChip: null,
      query: '',
      sort: 'changed',
      untitled: 'Untitled',
    });
    expect(view.rows.map((r) => r.entry.id)).toEqual(['a', 'c']);
    expect(view.openHere).toBe(1);
    expect(view.total).toBe(3);
  });

  it('with text, ranks before it sorts', () => {
    const x = entry('x', { title: 'deploy plan', modifiedAt: NOW - 900 * MIN });
    const y = entry('y', { title: 'the deploy', modifiedAt: NOW - 1 * MIN });
    const z = entry('z', { title: 'notes', preview: 'first\nhow we deploy', modifiedAt: NOW });
    expect(ids([z, y, x], { query: 'deploy' })).toEqual(['x', 'y', 'z']);
  });

  it('filters by tag prefix', () => {
    expect(ids([a, b, c], { query: '#op' })).toEqual(['c']);
  });
});

describe('entry helpers', () => {
  it('an untitled note gets the localized title', () => {
    expect(entryTitle(entry('a', { title: null }), 'Без названия')).toBe('Без названия');
  });

  it('drops the first non-empty line (the title) of a note preview', () => {
    expect(dropFirstLine('\n# Title\n- one\n- two')).toBe('- one\n- two');
    expect(dropFirstLine('   ')).toBe('');
  });

  it('shows a file path from its repo down', () => {
    expect(repoRelativePath('/Users/x/dev/infra/oncall/rota.md', 'infra')).toBe('oncall/rota.md');
    expect(repoRelativePath('/tmp/a.md', 'infra')).toBe('/tmp/a.md');
    expect(repoRelativePath('/tmp/a.md', null)).toBe('/tmp/a.md');
  });
});

describe('whenOf / formatWhen', () => {
  it('just now, today at a time, yesterday, days ago', () => {
    expect(whenOf(NOW - 30_000, NOW)).toEqual({ kind: 'now' });
    expect(whenOf(new Date(2026, 8, 26, 1, 55).getTime(), NOW)).toEqual({ kind: 'today', time: '01:55' });
    expect(whenOf(new Date(2026, 8, 25, 23, 0).getTime(), NOW)).toEqual({ kind: 'yesterday' });
    expect(whenOf(new Date(2026, 8, 23, 12, 0).getTime(), NOW)).toEqual({ kind: 'days', days: 3 });
  });

  it('reads in Russian', () => {
    installCatalog('ru');
    expect(formatWhen({ kind: 'now' })).toBe('только что');
    expect(formatWhen({ kind: 'today', time: '01:55' })).toBe('сегодня 01:55');
    expect(formatWhen({ kind: 'yesterday' })).toBe('вчера');
    expect(formatWhen({ kind: 'days', days: 3 })).toBe('3 дня назад');
    expect(formatWhen({ kind: 'days', days: 5 })).toBe('5 дней назад');
  });
});
```

- [ ] **Step 2: Run it — it fails**

Run: `npx vitest run src/lib/stash/stash-view.test.ts`
Expected: FAIL — cannot resolve `./stash-view`.

- [ ] **Step 3: Implement**

`src/lib/stash/stash-view.ts`:

```ts
/**
 * What the stash drawer shows (spec «Дровер тайника»): one flat list, no
 * sections; sorts «изменение · открытие · тип» (changed = the later of the
 * last edit and the last put-away); an entry open as a tab in THIS window is
 * not shown (the drawers are a move, not two views of one document). Pure.
 */
import type { Match, SearchIndex } from '../tabs/drawer-filter';
import { plural, t } from '../i18n';
import type { StashEntry } from './types';
import { matchStash, parseStashQuery } from './stash-query';

export type StashSort = 'changed' | 'opened' | 'kind';

export function changedAt(e: StashEntry): number {
  return Math.max(e.modifiedAt, e.stashedAt ?? 0);
}

function compare(sort: StashSort, a: StashEntry, b: StashEntry): number {
  switch (sort) {
    case 'changed':
      return changedAt(b) - changedAt(a);
    case 'opened':
      return (b.openedAt ?? 0) - (a.openedAt ?? 0) || changedAt(b) - changedAt(a);
    case 'kind':
      return (a.kind === b.kind ? 0 : a.kind === 'note' ? -1 : 1) || changedAt(b) - changedAt(a);
  }
}

/** A note with no text-derived title reads «Без названия»; a file's title is its name (Rust). */
export function entryTitle(e: StashEntry, untitled: string): string {
  return e.title ?? untitled;
}

export interface ViewInput {
  entries: readonly StashEntry[];
  indexes: ReadonlyMap<string, SearchIndex>;
  /** Paths open as tabs in this window. */
  openHere: ReadonlySet<string>;
  repoChip: string | null;
  query: string;
  sort: StashSort;
  untitled: string;
}

export interface ViewRow {
  entry: StashEntry;
  match: Match;
}

export interface StashView {
  rows: ViewRow[];
  /** Everything in the stash (not deleted), whatever the filter. */
  total: number;
  /** Entries that pass the filter but are open as tabs here. */
  openHere: number;
  /** The query's text part, lower-cased — what the cards highlight. */
  text: string;
}

export function stashView(input: ViewInput): StashView {
  const q = parseStashQuery(input.query);
  const hits: { row: ViewRow; order: number }[] = [];
  let openHere = 0;
  input.entries.forEach((entry, order) => {
    if (input.repoChip !== null && entry.repo !== input.repoChip) return;
    const match = matchStash(
      {
        title: entryTitle(entry, input.untitled),
        repo: entry.repo,
        tags: entry.tags,
        index: input.indexes.get(entry.id) ?? null,
      },
      q
    );
    if (!match) return;
    if (input.openHere.has(entry.path)) {
      openHere++;
      return;
    }
    hits.push({ row: { entry, match }, order });
  });
  hits.sort(
    (x, y) =>
      (q.text ? x.row.match.rank - y.row.match.rank : 0) ||
      compare(input.sort, x.row.entry, y.row.entry) ||
      x.order - y.order
  );
  return { rows: hits.map((h) => h.row), total: input.entries.length, openHere, text: q.text };
}

/** A note's preview without its first non-empty line — the title, already on the card. */
export function dropFirstLine(md: string): string {
  const lines = md.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim());
  return i < 0 ? '' : lines.slice(i + 1).join('\n');
}

/** A file ref's path from its repo down (`docs/plans/a.md`), else the whole path. */
export function repoRelativePath(path: string, repo: string | null): string {
  if (!repo) return path;
  const marker = `/${repo}/`;
  const at = path.indexOf(marker);
  return at < 0 ? path : path.slice(at + marker.length);
}

export type When =
  | { kind: 'now' }
  | { kind: 'today'; time: string }
  | { kind: 'yesterday' }
  | { kind: 'days'; days: number };

/** Less than this ago reads «только что». */
export const JUST_NOW_MS = 60_000;
const DAY_MS = 86_400_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local midnight of `ms`'s day, `offset` days later. Calendar days, so DST does not shift «вчера». */
function dayStart(ms: number, offset = 0): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime();
}

/** «отложено только что / сегодня 01:55 / вчера / 3 дня назад» (mockup `when`), in local time. */
export function whenOf(at: number, now: number): When {
  if (now - at < JUST_NOW_MS) return { kind: 'now' };
  if (at >= dayStart(now)) {
    const d = new Date(at);
    return { kind: 'today', time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  if (at >= dayStart(now, -1)) return { kind: 'yesterday' };
  return { kind: 'days', days: Math.round((dayStart(now) - dayStart(at)) / DAY_MS) };
}

export function formatWhen(w: When): string {
  switch (w.kind) {
    case 'now':
      return t('stash.when.now');
    case 'today':
      return t('stash.when.today', { time: w.time });
    case 'yesterday':
      return t('stash.when.yesterday');
    case 'days':
      return plural(w.days, 'stash.when.days_ago');
  }
}
```

- [ ] **Step 4: Run it — it passes**

Run: `npx vitest run src/lib/stash/stash-view.test.ts`
Expected: PASS (13 tests). If `types.ts` from stage 03 names a field differently (Task 0), fix the fixture and the module together.

- [ ] **Step 5: Commit**

```bash
git add src/lib/stash/stash-view.ts src/lib/stash/stash-view.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): visible list, sorts (changed/opened/kind) and «отложено …» labels

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/stash/stash-view.ts src/lib/stash/stash-view.test.ts
```

---

## Task 6: The drawer pair's state, key routing and pulse diff (pure)

**Files:**
- Create: `src/lib/stash/stash-state.ts`
- Create: `src/lib/stash/stash-state.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/stash/stash-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { KeyLike } from '../tabs/drawer-state';
import type { StashEntry } from './types';
import {
  STASH_CLOSED,
  STASH_SORT_KEYS,
  arrowFocus,
  backspaceStash,
  closeStash,
  escapeStash,
  focusDrawer,
  moveStashKb,
  openStash,
  pulses,
  setRepoChip,
  setStashQuery,
  setStashSort,
  stashKbTarget,
  stashKeyAction,
} from './stash-state';

function key(k: string, over: Partial<KeyLike> = {}): KeyLike {
  const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
  return { key: k, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over };
}

function entry(id: string, over: Partial<StashEntry> = {}): StashEntry {
  return {
    id,
    kind: 'note',
    path: `/n/${id}.md`,
    title: id,
    repo: null,
    branch: null,
    tags: [],
    createdAt: 0,
    modifiedAt: 0,
    stashedAt: 10,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: '',
    ...over,
  };
}

describe('open / close / focus', () => {
  it('opening takes the keys and starts filtered by the window repo', () => {
    expect(openStash(STASH_CLOSED, 'shelf-design')).toEqual({
      ...STASH_CLOSED,
      open: true,
      focus: 'stash',
      repoChip: 'shelf-design',
    });
  });

  it('opening an open stash only takes the keys back', () => {
    const s = { ...openStash(STASH_CLOSED, 'r'), focus: 'tabs' as const, query: 'x', repoChip: null };
    expect(openStash(s, 'r')).toEqual({ ...s, focus: 'stash' });
  });

  it('closing drops the query and the ring, keeps the sort', () => {
    const s = setStashSort(setStashQuery(openStash(STASH_CLOSED, null), 'abc'), 'kind');
    expect(closeStash(s)).toEqual({ ...STASH_CLOSED, sort: 'kind', repoChip: null });
  });

  it('the stash cannot have the keys while closed', () => {
    expect(focusDrawer(STASH_CLOSED, 'stash')).toBe(STASH_CLOSED);
    const open = openStash(STASH_CLOSED, null);
    expect(focusDrawer(open, 'tabs').focus).toBe('tabs');
    expect(focusDrawer(focusDrawer(open, 'tabs'), 'stash').focus).toBe('stash');
  });
});

describe('Esc and Backspace', () => {
  it('Esc clears the query, then closes', () => {
    const s = setStashQuery(openStash(STASH_CLOSED, null), 'ab');
    const cleared = escapeStash(s);
    expect(cleared.query).toBe('');
    expect(cleared.open).toBe(true);
    expect(escapeStash(cleared).open).toBe(false);
  });

  it('Backspace edits the query, then drops the repo chip, then does nothing', () => {
    let s = setStashQuery(openStash(STASH_CLOSED, 'infra'), 'ab');
    s = backspaceStash(s);
    expect(s.query).toBe('a');
    s = backspaceStash(backspaceStash(s));
    expect(s.query).toBe('');
    expect(s.repoChip).toBeNull();
    expect(backspaceStash(s)).toBe(s);
  });

  it('the chip can be put back', () => {
    expect(setRepoChip(openStash(STASH_CLOSED, null), 'infra').repoChip).toBe('infra');
  });
});

describe('keyboard ring', () => {
  const visible = ['a', 'b', 'c'];

  it('the top result is the target while searching', () => {
    expect(stashKbTarget(openStash(STASH_CLOSED, null), visible)).toBeNull();
    expect(stashKbTarget(setStashQuery(openStash(STASH_CLOSED, null), 'x'), visible)).toBe('a');
  });

  it('arrows start at an end and stay inside', () => {
    const s = openStash(STASH_CLOSED, null);
    expect(moveStashKb(s, 1, visible).kb).toBe('a');
    expect(moveStashKb(s, -1, visible).kb).toBe('c');
    expect(moveStashKb(moveStashKb(s, 1, visible), -1, visible).kb).toBe('a');
    expect(moveStashKb(s, 1, [])).toBe(s);
  });
});

describe('stashKeyAction', () => {
  it('maps the stash keys', () => {
    expect(stashKeyAction(key('Escape'), '', true)).toEqual({ kind: 'escape' });
    expect(stashKeyAction(key('l', { metaKey: true }), '', true)).toEqual({ kind: 'sort', sort: 'changed' });
    expect(stashKeyAction(key('r', { metaKey: true }), '', true)).toEqual({ kind: 'sort', sort: 'opened' });
    expect(stashKeyAction(key('u', { metaKey: true }), '', true)).toEqual({ kind: 'sort', sort: 'kind' });
    expect(stashKeyAction(key('#', { code: 'Digit3', shiftKey: true }), '', true)).toEqual({ kind: 'type', char: '#' });
    expect(stashKeyAction(key('Backspace'), '', true)).toEqual({ kind: 'backspace' });
    expect(stashKeyAction(key('ArrowDown'), '', true)).toEqual({ kind: 'move', delta: 1 });
    expect(stashKeyAction(key('ArrowUp'), '', true)).toEqual({ kind: 'move', delta: -1 });
    expect(stashKeyAction(key('Enter'), '', true)).toEqual({ kind: 'enter' });
  });

  it('leaves what it does not use', () => {
    expect(stashKeyAction(key(' ', { code: 'Space' }), '', true)).toEqual({ kind: 'none' });
    expect(stashKeyAction(key(' ', { code: 'Space' }), 'a', true)).toEqual({ kind: 'type', char: ' ' });
    expect(stashKeyAction(key('g', { metaKey: true }), '', true)).toEqual({ kind: 'none' });
    expect(stashKeyAction(key('Escape', { shiftKey: true }), '', true)).toEqual({ kind: 'none' });
    expect(stashKeyAction(key('a', { isComposing: true }), '', true)).toEqual({ kind: 'none' });
    expect(stashKeyAction(key('Tab'), '', true)).toEqual({ kind: 'none' });
  });

  it('the command key is Ctrl off a Mac', () => {
    expect(stashKeyAction(key('l', { ctrlKey: true }), '', false)).toEqual({ kind: 'sort', sort: 'changed' });
    expect(stashKeyAction(key('l', { ctrlKey: true }), '', true)).toEqual({ kind: 'none' });
  });

  it('shares ⌘L/⌘R/⌘U with the tabs drawer', () => {
    expect(STASH_SORT_KEYS.map((k) => k.accelerator)).toEqual(['CmdOrCtrl+L', 'CmdOrCtrl+R', 'CmdOrCtrl+U']);
  });
});

describe('arrowFocus', () => {
  it('bare ← and → only', () => {
    expect(arrowFocus(key('ArrowLeft'))).toBe('left');
    expect(arrowFocus(key('ArrowRight'))).toBe('right');
    expect(arrowFocus(key('ArrowRight', { shiftKey: true }))).toBeNull();
    expect(arrowFocus(key('ArrowRight', { metaKey: true }))).toBeNull();
    expect(arrowFocus(key('ArrowRight', { isComposing: true }))).toBeNull();
    expect(arrowFocus(key('ArrowDown'))).toBeNull();
  });
});

describe('pulses', () => {
  it('a card on screen whose put-away time grew pulses; new tags pop', () => {
    const before = [entry('a', { stashedAt: 10 }), entry('b', { stashedAt: 10, tags: ['x'] }), entry('c')];
    const after = [
      entry('a', { stashedAt: 20 }),
      entry('b', { stashedAt: 10, tags: ['x', 'review'] }),
      entry('c', { stashedAt: 30 }),
      entry('d'),
    ];
    const diff = pulses(before, after, new Set(['a', 'b']));
    expect(diff.pulse).toEqual(['a']);
    expect([...diff.newTags]).toEqual([['b', ['review']]]);
  });

  it('a first load pulses nothing', () => {
    expect(pulses([], [entry('a')], new Set()).pulse).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — it fails**

Run: `npx vitest run src/lib/stash/stash-state.test.ts`
Expected: FAIL — cannot resolve `./stash-state`.

- [ ] **Step 3: Implement**

`src/lib/stash/stash-state.ts`:

```ts
/**
 * The two drawers as one keyboard (spec «Оба дровера вместе», «Клавиатура»):
 * which one has the keys, the stash's query, sort, repo chip and ring, and
 * what a key does while the stash has the keys. Pure — the runes store wraps
 * it (`stash-store.svelte.ts`), `TabDrawer` routes keys through it.
 */
import type { KeyLike } from '../tabs/drawer-state';
import type { StashSort } from './stash-view';
import type { StashEntry } from './types';

export type DrawerFocus = 'tabs' | 'stash';

export interface StashState {
  open: boolean;
  /** Which drawer has the keys. `'stash'` only while open. */
  focus: DrawerFocus;
  query: string;
  /** A mode, kept across opens for the window's life (mockup `aria-pressed`). */
  sort: StashSort;
  /** The repo filter chip; `null`: the whole stash. */
  repoChip: string | null;
  /** The card the arrows reached; `null` until they are used. */
  kb: string | null;
}

export const STASH_CLOSED: StashState = {
  open: false,
  focus: 'tabs',
  query: '',
  sort: 'changed',
  repoChip: null,
  kb: null,
};

/** Every opening starts clean and filtered by the window's repo (mockup `openStash`). */
export function openStash(s: StashState, windowRepo: string | null): StashState {
  if (s.open) return s.focus === 'stash' ? s : { ...s, focus: 'stash' };
  return { ...s, open: true, focus: 'stash', query: '', kb: null, repoChip: windowRepo };
}

export function closeStash(s: StashState): StashState {
  return s.open ? { ...s, open: false, focus: 'tabs', query: '', kb: null } : s;
}

export function focusDrawer(s: StashState, focus: DrawerFocus): StashState {
  const next: DrawerFocus = focus === 'stash' && !s.open ? 'tabs' : focus;
  return next === s.focus ? s : { ...s, focus: next };
}

export function setStashQuery(s: StashState, query: string): StashState {
  return { ...s, query, kb: null };
}

export function setStashSort(s: StashState, sort: StashSort): StashState {
  return s.sort === sort ? s : { ...s, sort };
}

export function setRepoChip(s: StashState, repoChip: string | null): StashState {
  return { ...s, repoChip, kb: null };
}

/** First Esc clears the query, the next closes the stash (spec «Esc»). */
export function escapeStash(s: StashState): StashState {
  return s.query ? setStashQuery(s, '') : closeStash(s);
}

/** ⌫ edits the query; on an empty one it drops the repo chip (mockup); then nothing. */
export function backspaceStash(s: StashState): StashState {
  if (s.query) return setStashQuery(s, s.query.slice(0, -1));
  if (s.repoChip !== null) return setRepoChip(s, null);
  return s;
}

/** The card Enter opens: the one the arrows reached, else — while searching — the top result. */
export function stashKbTarget(s: StashState, visible: readonly string[]): string | null {
  if (s.kb !== null && visible.includes(s.kb)) return s.kb;
  return s.query ? (visible[0] ?? null) : null;
}

export function moveStashKb(s: StashState, delta: 1 | -1, visible: readonly string[]): StashState {
  if (visible.length === 0) return s;
  const from = visible.indexOf(stashKbTarget(s, visible) ?? '');
  if (from === -1) return { ...s, kb: delta === 1 ? visible[0] : visible[visible.length - 1] };
  const to = Math.min(visible.length - 1, Math.max(0, from + delta));
  return { ...s, kb: visible[to] };
}

/** ⌘L / ⌘R / ⌘U in the stash (spec: «изменение ⌘L · открытие ⌘R · тип ⌘U»). */
export interface StashSortKey {
  sort: StashSort;
  code: string;
  accelerator: string;
}

/** The same keys as the tabs drawer's sorts: `drawer-keys.test.ts` already keeps them off the menu. */
export const STASH_SORT_KEYS: readonly StashSortKey[] = [
  { sort: 'changed', code: 'KeyL', accelerator: 'CmdOrCtrl+L' },
  { sort: 'opened', code: 'KeyR', accelerator: 'CmdOrCtrl+R' },
  { sort: 'kind', code: 'KeyU', accelerator: 'CmdOrCtrl+U' },
];

export type StashKeyAction =
  | { kind: 'escape' }
  | { kind: 'sort'; sort: StashSort }
  | { kind: 'type'; char: string }
  | { kind: 'backspace' }
  | { kind: 'move'; delta: 1 | -1 }
  | { kind: 'enter' }
  | { kind: 'none' };

/** What a key does while the stash has the keys. `none` lets the event through. */
export function stashKeyAction(e: KeyLike, query: string, mac: boolean): StashKeyAction {
  if (e.isComposing || e.keyCode === 229) return { kind: 'none' };
  const modified = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
  if (e.key === 'Escape') return modified ? { kind: 'none' } : { kind: 'escape' };
  const command = mac ? e.metaKey : e.ctrlKey;
  if (command && !e.shiftKey && !e.altKey) {
    const sort = STASH_SORT_KEYS.find((k) => k.code === e.code)?.sort;
    return sort ? { kind: 'sort', sort } : { kind: 'none' };
  }
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
    if (e.key === ' ' && !query) return { kind: 'none' };
    return { kind: 'type', char: e.key };
  }
  if (e.key === 'Backspace') return { kind: 'backspace' };
  if (e.key === 'ArrowDown') return { kind: 'move', delta: 1 };
  if (e.key === 'ArrowUp') return { kind: 'move', delta: -1 };
  if (e.key === 'Enter') return { kind: 'enter' };
  return { kind: 'none' };
}

/** Bare ← / → move the keys between the drawers (spec). */
export function arrowFocus(e: KeyLike): 'left' | 'right' | null {
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.key === 'ArrowLeft') return 'left';
  if (e.key === 'ArrowRight') return 'right';
  return null;
}

/**
 * After a reload: cards that were on screen and were put away again (another
 * window's dedup: «поднять его наверх») pulse; tags that were not there pop.
 * `stash-changed` carries no ids, so this is a diff.
 */
export function pulses(
  prev: readonly StashEntry[],
  next: readonly StashEntry[],
  shown: ReadonlySet<string>
): { pulse: string[]; newTags: Map<string, string[]> } {
  const before = new Map(prev.map((e) => [e.id, e]));
  const pulse: string[] = [];
  const newTags = new Map<string, string[]>();
  for (const e of next) {
    const old = before.get(e.id);
    if (!old) continue;
    if (shown.has(e.id) && (e.stashedAt ?? 0) > (old.stashedAt ?? 0)) pulse.push(e.id);
    const added = e.tags.filter((tag) => !old.tags.includes(tag));
    if (added.length > 0) newTags.set(e.id, added);
  }
  return { pulse, newTags };
}
```

- [ ] **Step 4: Run it — it passes**

Run: `npx vitest run src/lib/stash/stash-state.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stash/stash-state.ts src/lib/stash/stash-state.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): drawer-pair reducer, stash key routing and dedup pulse diff

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/stash/stash-state.ts src/lib/stash/stash-state.test.ts
```

---

## Task 7: Drop targets and the stash toast's text (pure)

**Files:**
- Create: `src/lib/stash/drop-target.ts`, `src/lib/stash/drop-target.test.ts`
- Create: `src/lib/stash/stash-toast.ts`, `src/lib/stash/stash-toast.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/lib/stash/drop-target.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveDrop, type DropHits } from './drop-target';

const none: DropHits = { stashDrawer: false, stashZone: false, list: false, tabsDrawer: false };

describe('resolveDrop', () => {
  it('a tab card: the stash drawer, the stash zone, the list, else the page', () => {
    expect(resolveDrop('tabs', { ...none, stashDrawer: true }, false)).toBe('stash-drawer');
    expect(resolveDrop('tabs', { ...none, stashZone: true, tabsDrawer: true }, false)).toBe('stash-zone');
    expect(resolveDrop('tabs', { ...none, list: true, tabsDrawer: true }, false)).toBe('list');
    expect(resolveDrop('tabs', { ...none, tabsDrawer: true }, false)).toBe('none');
    expect(resolveDrop('tabs', none, false)).toBe('page');
  });

  it('a filtered tab list takes no drop (no manual order to drop into)', () => {
    expect(resolveDrop('tabs', { ...none, list: true, tabsDrawer: true }, true)).toBe('none');
    expect(resolveDrop('tabs', { ...none, stashZone: true, tabsDrawer: true }, true)).toBe('stash-zone');
  });

  it('a stash card: anywhere on the tabs drawer opens it, elsewhere cancels', () => {
    expect(resolveDrop('stash', { ...none, list: true, tabsDrawer: true }, false)).toBe('tabs-drawer');
    expect(resolveDrop('stash', { ...none, tabsDrawer: true }, false)).toBe('tabs-drawer');
    expect(resolveDrop('stash', { ...none, stashDrawer: true }, false)).toBe('none');
    expect(resolveDrop('stash', none, false)).toBe('none');
  });
});
```

`src/lib/stash/stash-toast.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCatalog } from '../i18n';
import { stashToastText, type StashToastNote } from './stash-toast';

beforeEach(() => installCatalog('ru'));
afterEach(() => installCatalog('en'));

type PutAway = Extract<StashToastNote, { what: 'put-away' }>;

const put = (over: Partial<PutAway>): StashToastNote => ({
  what: 'put-away',
  count: 1,
  dup: 0,
  lead: 'report.md',
  leadIsNote: false,
  hidden: 0,
  hiddenBy: null,
  onlyEmpty: false,
  emptyToo: false,
  ...over,
});

describe('stashToastText', () => {
  it('one file, new', () => {
    expect(stashToastText(put({}))).toEqual({ text: 'report.md → тайник', dim: '· отложено' });
  });

  it('one file already in the stash', () => {
    expect(stashToastText(put({ dup: 1 }))).toEqual({
      text: 'report.md → тайник',
      dim: '· запись уже была — вторая не создана',
    });
  });

  it('one note', () => {
    expect(stashToastText(put({ lead: 'Планы', leadIsNote: true }))).toEqual({
      text: 'Заметка Планы → тайник',
      dim: '· отложена',
    });
  });

  it('several, with duplicates, hidden by the chip, and an empty note', () => {
    expect(stashToastText(put({ count: 3, dup: 1, hidden: 2, hiddenBy: 'infra', emptyToo: true }))).toEqual({
      text: 'Отложено в тайник: 3',
      dim: '· для 1 запись уже была — дублей нет · скрыты фильтром #infra · пустая заметка просто закрыта',
    });
  });

  it('only an empty note', () => {
    expect(stashToastText(put({ count: 0, onlyEmpty: true }))).toEqual({
      text: 'Пустая заметка закрыта',
      dim: '· хранить нечего',
    });
  });

  it('opened, moved, removed, widened, failed, error', () => {
    expect(stashToastText({ what: 'opened', title: 'Планы', isNote: true, from: null })).toEqual({
      text: 'Планы открыта вкладкой',
      dim: '· из тайника',
    });
    expect(stashToastText({ what: 'opened', title: 'a.md', isNote: false, from: 12 }).dim).toBe('· переехал из #12');
    expect(stashToastText({ what: 'removed', title: 'a.md' })).toEqual({
      text: 'a.md убран из тайника',
      dim: '· файл остался на месте',
    });
    expect(stashToastText({ what: 'widened' }).dim).toBe('· вернётся, когда тайник закроется');
    expect(stashToastText({ what: 'pull-failed', number: 19, label: 'editor-19' }).text).toBe(
      'Не получилось перенести из #19'
    );
    expect(stashToastText({ what: 'error', message: 'database is locked' })).toEqual({
      text: 'Тайник не ответил',
      dim: 'database is locked',
    });
  });
});
```

- [ ] **Step 2: Run them — they fail**

Run: `npx vitest run src/lib/stash/drop-target.test.ts src/lib/stash/stash-toast.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`src/lib/stash/drop-target.ts`:

```ts
/**
 * Where a dragged card would land (stash stage 04). Tab cards: the stash
 * drawer or the stash zone at the bottom of the tabs drawer put them away;
 * the unfiltered list reorders; the rest of the tabs drawer cancels; the page
 * is the window carousel's (plan 05). Stash cards: anywhere on the tabs drawer
 * opens them here (mockup `hitTarget`). The caller hit-tests the rectangles.
 */
export type DragSource = 'tabs' | 'stash';

export type DropTarget = 'list' | 'stash-zone' | 'stash-drawer' | 'tabs-drawer' | 'page' | 'none';

export interface DropHits {
  stashDrawer: boolean;
  /** The stash area at the bottom of the tabs drawer — inside it, so tested first. */
  stashZone: boolean;
  list: boolean;
  /** The tabs drawer or its notch. */
  tabsDrawer: boolean;
}

export function resolveDrop(src: DragSource, hits: DropHits, filtered: boolean): DropTarget {
  if (src === 'stash') return hits.tabsDrawer || hits.list ? 'tabs-drawer' : 'none';
  if (hits.stashDrawer) return 'stash-drawer';
  if (hits.stashZone) return 'stash-zone';
  if (hits.list) return filtered ? 'none' : 'list';
  if (hits.tabsDrawer) return 'none';
  return 'page';
}
```

`src/lib/stash/stash-toast.ts`:

```ts
/**
 * The `stash` toast (stash stage 04): one kind for every stash notice, so a
 * newer one replaces the last (`toasts.push` replaces a kind). Copy from the
 * mockup's toasts. `stashToastText` is what `ToastStack` renders — plain text,
 * never `{@html}` (titles are user text).
 */
import { plural, t } from '../i18n';

export type StashToastNote =
  | {
      what: 'put-away';
      /** Entries the put-away returned. */
      count: number;
      /** File refs that were already in the stash (a note always is, so notes never count). */
      dup: number;
      /** The first entry's title. */
      lead: string | null;
      leadIsNote: boolean;
      /** How many of them the repo chip hides right now. */
      hidden: number;
      hiddenBy: string | null;
      /** Only empty tabs were closed: nothing to keep. */
      onlyEmpty: boolean;
      /** Empty tabs were closed along with the rest. */
      emptyToo: boolean;
    }
  | { what: 'opened'; title: string; isNote: boolean; from: number | null }
  | { what: 'removed'; title: string }
  | { what: 'widened' }
  | { what: 'pull-failed'; number: number | null; label: string }
  | { what: 'error'; message: string };

export interface StashToastText {
  text: string;
  dim: string;
}

function putAwayText(note: Extract<StashToastNote, { what: 'put-away' }>): StashToastText {
  if (note.onlyEmpty) return { text: t('toast.stash.only_empty'), dim: t('toast.stash.only_empty_tail') };
  const title = note.lead ?? '';
  const dims: string[] = [];
  let text: string;
  if (note.count === 1 && note.leadIsNote) {
    text = t('toast.stash.put_note', { title });
    dims.push(t('toast.stash.put_note_tail'));
  } else if (note.count === 1 && note.dup === 1) {
    text = t('toast.stash.put_one', { title });
    dims.push(t('toast.stash.put_dup_tail'));
  } else if (note.count === 1) {
    text = t('toast.stash.put_one', { title });
    dims.push(t('toast.stash.put_one_tail'));
  } else {
    text = t('toast.stash.put_many', { count: note.count });
    if (note.dup > 0) dims.push(t('toast.stash.put_many_dup', { dup: note.dup }));
  }
  if (note.hidden > 0 && note.hiddenBy !== null) {
    dims.push(plural(note.hidden, 'toast.stash.hidden', { repo: note.hiddenBy }));
  }
  if (note.emptyToo) dims.push(t('toast.stash.empty_too'));
  return { text, dim: dims.join(' ') };
}

export function stashToastText(note: StashToastNote): StashToastText {
  switch (note.what) {
    case 'put-away':
      return putAwayText(note);
    case 'opened':
      return {
        text: t(note.isNote ? 'toast.stash.opened_note' : 'toast.stash.opened_file', { title: note.title }),
        dim:
          note.from === null
            ? t('toast.stash.from_stash')
            : t(note.isNote ? 'toast.stash.moved_note' : 'toast.stash.moved_file', { n: note.from }),
      };
    case 'removed':
      return { text: t('toast.stash.removed', { title: note.title }), dim: t('toast.stash.removed_tail') };
    case 'widened':
      return { text: t('toast.stash.widened'), dim: t('toast.stash.widened_tail') };
    case 'pull-failed':
      return { text: t('toast.stash.pull_failed', { n: note.number ?? '?' }), dim: '' };
    case 'error':
      return { text: t('toast.stash.error'), dim: note.message };
  }
}
```

- [ ] **Step 4: Run them — they pass**

Run: `npx vitest run src/lib/stash/drop-target.test.ts src/lib/stash/stash-toast.test.ts`
Expected: PASS (3 + 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stash/drop-target.ts src/lib/stash/drop-target.test.ts src/lib/stash/stash-toast.ts src/lib/stash/stash-toast.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): drop-target resolution and stash toast text

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/stash/drop-target.ts src/lib/stash/drop-target.test.ts src/lib/stash/stash-toast.ts src/lib/stash/stash-toast.test.ts
```

---

## Task 8: `tab_holders`, `tab_request_move`, `window_repo` (Rust)

**Files:**
- Modify: `src-tauri/src/tab_commands.rs` (new items after `tab_carousel_windows`; tests at the end of `mod tests`)
- Modify: `src-tauri/src/lib.rs` (`invoke_handler`, after `tab_commands::tab_carousel_windows,`)

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests` of `src-tauri/src/tab_commands.rs` (it already has `reg_with`):

```rust
    #[test]
    fn holders_of_names_other_live_windows_with_their_number() {
        let mut reg = reg_with(&[
            ("main", "a", Some("/a.md")),
            ("editor-2", "b", Some("/b.md")),
            ("editor-3", "c", Some("/c.md")),
        ]);
        reg.set_number("editor-2", Some(7));
        let paths: Vec<String> = ["/a.md", "/b.md", "/c.md", "/z.md"].iter().map(|p| p.to_string()).collect();
        assert_eq!(
            holders_of(&reg, &paths, "main", |label| label != "editor-3"),
            vec![None, Some(TabHolder { label: "editor-2".into(), number: Some(7) }), None, None],
            "own tabs, dead windows and free files are all None"
        );
    }

    #[test]
    fn pull_answer_says_here_elsewhere_or_free() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("editor-2", "b", Some("/b.md"))]);
        reg.set_number("editor-2", Some(4));
        assert_eq!(pull_answer(&reg, "/a.md", "main", |_| true), PullAnswer::ThisWindow { tab_id: "a".into() });
        assert_eq!(
            pull_answer(&reg, "/b.md", "main", |_| true),
            PullAnswer::Requested { label: "editor-2".into(), number: Some(4) }
        );
        assert_eq!(pull_answer(&reg, "/b.md", "main", |_| false), PullAnswer::NotOpen);
        assert_eq!(pull_answer(&reg, "/z.md", "main", |_| true), PullAnswer::NotOpen);
    }

    #[test]
    fn pull_answers_and_holders_serialize_for_the_frontend() {
        assert_eq!(serde_json::to_value(PullAnswer::NotOpen).unwrap(), serde_json::json!({ "kind": "not-open" }));
        assert_eq!(
            serde_json::to_value(PullAnswer::ThisWindow { tab_id: "a".into() }).unwrap(),
            serde_json::json!({ "kind": "this-window", "tabId": "a" })
        );
        assert_eq!(
            serde_json::to_value(PullAnswer::Requested { label: "editor-2".into(), number: None }).unwrap(),
            serde_json::json!({ "kind": "requested", "label": "editor-2", "number": null })
        );
        assert_eq!(
            serde_json::to_value(TabHolder { label: "x".into(), number: Some(3) }).unwrap(),
            serde_json::json!({ "label": "x", "number": 3 })
        );
        assert_eq!(
            serde_json::to_value(PullRequest { path: "/a.md".into(), target: "main".into() }).unwrap(),
            serde_json::json!({ "path": "/a.md", "target": "main" })
        );
    }

    #[test]
    fn repo_of_window_is_the_project_directory_name() {
        let mut reg = TabRegistry::new();
        assert_eq!(repo_of_window(&reg, "main"), None);
        reg.bind_project("main", "/Users/x/dev/shelf-design".to_string());
        assert_eq!(repo_of_window(&reg, "main").as_deref(), Some("shelf-design"));
    }
```

- [ ] **Step 2: Run them — they fail to compile**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml tab_commands`
Expected: compile errors — `holders_of`, `TabHolder`, `pull_answer`, `PullAnswer`, `PullRequest`, `repo_of_window` not found.

- [ ] **Step 3: Implement**

In `src-tauri/src/tab_commands.rs`, after the `tab_carousel_windows` command (before `#[cfg(test)]`), add:

```rust
/// Who holds a stash entry's file, seen from another window (stash stage 04:
/// «открыта в #N»). `number` is that window's `#N`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabHolder {
    pub label: String,
    pub number: Option<u32>,
}

/// For each path: the live window other than `caller` holding it, else `None`
/// (nobody, a window that is gone, or `caller` itself — the stash drawer hides
/// those by its own tab list).
pub fn holders_of(
    reg: &TabRegistry,
    paths: &[String],
    caller: &str,
    is_live: impl Fn(&str) -> bool,
) -> Vec<Option<TabHolder>> {
    paths
        .iter()
        .map(|path| match owner_for(reg, path, caller, &is_live) {
            TabOwner::OtherWindow { label } => Some(TabHolder {
                number: reg.window(&label).and_then(|w| w.number),
                label,
            }),
            _ => None,
        })
        .collect()
}

/// IPC (stash stage 04): the holders of many paths under one lock. The paths
/// come from the stash database, which stores the registry's own spelling
/// (`path_norm::normalize_str`), so they are not normalized again — that would
/// touch the disk once per entry, under nothing but a loop.
#[tauri::command]
pub async fn tab_holders(
    app: AppHandle,
    window: tauri::WebviewWindow,
    paths: Vec<String>,
) -> Result<Vec<Option<TabHolder>>, String> {
    let open_files = app.state::<OpenFiles>();
    let reg = open_files.0.lock().unwrap();
    Ok(holders_of(&reg, &paths, window.label(), live_windows(&app)))
}

/// What opening a stash entry here means (stash stage 04, spec «Перенос»).
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PullAnswer {
    /// Nobody holds it: open it here.
    NotOpen,
    /// This window already has it: show that tab.
    ThisWindow {
        #[serde(rename = "tabId")]
        tab_id: String,
    },
    /// Another window holds it and was asked (`tab-pull`) to move it here.
    Requested { label: String, number: Option<u32> },
}

/// `tab-pull`'s payload: move the tab holding `path` to window `target`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub path: String,
    pub target: String,
}

pub fn pull_answer(reg: &TabRegistry, path: &str, caller: &str, is_live: impl Fn(&str) -> bool) -> PullAnswer {
    match owner_for(reg, path, caller, is_live) {
        TabOwner::None => PullAnswer::NotOpen,
        TabOwner::ThisWindow { tab_id } => PullAnswer::ThisWindow { tab_id },
        TabOwner::OtherWindow { label } => PullAnswer::Requested {
            number: reg.window(&label).and_then(|w| w.number),
            label,
        },
    }
}

/// IPC (stash stage 04): «открыть его отсюда — перенести из того окна». A move
/// is driven by the window that holds the tab (`tab_move`: its dirty checks,
/// its caret, its agent inbox), so this only asks the holder, with `tab-pull`,
/// emitted after the lock is dropped — nothing orders after it. The holder's
/// frontend runs its own `tab_move` to the caller; the caller watches for the
/// arrival (`PULL_WAIT_MS` in `open-from-stash.ts`).
#[tauri::command]
pub async fn tab_request_move(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<PullAnswer, String> {
    // Before the lock: normalizing asks the file system.
    let path = crate::path_norm::normalize_str(&path);
    let answer = {
        let open_files = app.state::<OpenFiles>();
        let reg = open_files.0.lock().unwrap();
        pull_answer(&reg, &path, window.label(), live_windows(&app))
    };
    if let PullAnswer::Requested { label, .. } = &answer {
        let request = PullRequest { path: path.clone(), target: window.label().to_string() };
        app.emit_to(label.as_str(), "tab-pull", request).map_err(|e| e.to_string())?;
    }
    Ok(answer)
}

/// The window's project as the stash names a repo: the directory name of its
/// root (`git_info::dir_name`) — the spelling file refs get from Rust too.
pub fn repo_of_window(reg: &TabRegistry, label: &str) -> Option<String> {
    reg.window(label)
        .and_then(|w| w.project.as_deref())
        .map(|p| crate::git_info::dir_name(std::path::Path::new(p)))
}

/// IPC (stash stage 04): the repo the stash drawer opens filtered by (spec
/// «Окно проекта открывает тайник уже отфильтрованным»). `None`: no project.
#[tauri::command]
pub async fn window_repo(app: AppHandle, window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    // Before the lock: binding walks the file system.
    crate::routing::bind_missing_projects(&app);
    let open_files = app.state::<OpenFiles>();
    let reg = open_files.0.lock().unwrap();
    Ok(repo_of_window(&reg, window.label()))
}
```

In `src-tauri/src/lib.rs`, in `invoke_handler`, right after `tab_commands::tab_carousel_windows,` add:

```rust
            tab_commands::tab_holders,
            tab_commands::tab_request_move,
            tab_commands::window_repo,
```

- [ ] **Step 4: Run the tests — they pass**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml tab_commands`
Expected: PASS, including the 4 new tests.

- [ ] **Step 5: Clippy**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "generated [0-9]+ warning"`
Expected: the baseline count from Task 0, not more.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/tab_commands.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(stash): tab_holders, tab_request_move (+ tab-pull) and window_repo

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src-tauri/src/tab_commands.rs src-tauri/src/lib.rs
```

---

## Task 9: `stash_delete` for file references (Rust)

**Files:**
- Modify: `src-tauri/src/stash/entries.rs` (a new `remove_file_ref` and a new test module)
- Modify: `src-tauri/src/stash/commands.rs` (`stash_delete`)
- Modify: `src-tauri/src/lib.rs` (register next to the other `stash::commands::*`)

Names from stage 02 (`state.conn`, `emit_changed`, `db::migrate`) are the plan's; use the ones in `$QA/substitutions.md`.

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/stash/entries.rs`:

```rust
#[cfg(test)]
mod remove_file_ref_tests {
    use super::remove_file_ref;

    fn db(file_path: &str) -> rusqlite::Connection {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::stash::db::migrate(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO entries (id, kind, path, title, created_at, modified_at) VALUES ('f1', 'file', ?1, 'a.md', 1, 1)",
            [file_path],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO entries (id, kind, path, title, created_at, modified_at) VALUES ('n1', 'note', '/notes/x.md', 'x', 1, 1);
             INSERT INTO tags (entry_id, tag) VALUES ('f1', 'infra'), ('n1', 'ideas');",
        )
        .unwrap();
        conn
    }

    fn count(conn: &rusqlite::Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_file_ref_leaves_with_its_tags_and_the_file_stays() {
        let file = std::env::temp_dir().join(format!("couplet-stash-ref-{}.md", std::process::id()));
        std::fs::write(&file, "keep me").unwrap();
        let mut conn = db(file.to_str().unwrap());
        remove_file_ref(&mut conn, "f1").unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM entries WHERE id = 'f1'"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM tags WHERE entry_id = 'f1'"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM entries"), 1);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep me", "the user's file is never touched");
        std::fs::remove_file(&file).unwrap();
    }

    #[test]
    fn a_note_and_an_unknown_id_are_refused_and_nothing_changes() {
        let mut conn = db("/r/a.md");
        assert!(remove_file_ref(&mut conn, "n1").unwrap_err().contains("note"));
        assert!(remove_file_ref(&mut conn, "nope").is_err());
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM entries"), 2);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM tags"), 2);
    }
}
```

(If `migrate` takes `&Connection`, write `crate::stash::db::migrate(&conn)` and drop `mut` from that binding only; `remove_file_ref` still needs `&mut`.)

- [ ] **Step 2: Run them — they fail to compile**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml remove_file_ref`
Expected: `cannot find function remove_file_ref`.

- [ ] **Step 3: Implement**

In `src-tauri/src/stash/entries.rs` (above the test modules):

```rust
/// «убрать из тайника» for a file reference (stash stage 04): the entry, its
/// tags and its search row go, in one transaction; the file itself is never
/// touched. A note is refused: its text is the user's and leaves only through
/// the trash — stage 06 turns this refusal into that move.
pub fn remove_file_ref(conn: &mut rusqlite::Connection, id: &str) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let row: Option<(i64, String)> = tx
        .query_row("SELECT rowid, kind FROM entries WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    let (rowid, kind) = row.ok_or_else(|| format!("no stash entry {id}"))?;
    if kind != "file" {
        return Err(format!("stash entry {id} is a note: notes are deleted through the trash"));
    }
    tx.execute("DELETE FROM entries_fts WHERE rowid = ?1", [rowid]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM tags WHERE entry_id = ?1", [id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM entries WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
```

(The tags are deleted explicitly rather than by `ON DELETE CASCADE`: the cascade needs `PRAGMA foreign_keys = ON` on this very connection, and a missing pragma would leave orphan tags silently.)

In `src-tauri/src/stash/commands.rs`:

```rust
/// IPC (stash stage 04, file branch — stage 06 adds the note trash): take a
/// file reference out of the stash. `stash-changed` goes out once, after.
#[tauri::command]
pub async fn stash_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<crate::stash::StashState>();
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        crate::stash::entries::remove_file_ref(&mut conn, &id)?;
    }
    crate::stash::emit_changed(&app, "delete");
    Ok(())
}
```

(Add `use tauri::Manager;` at the top of the file if it is not there.) In `src-tauri/src/lib.rs`, next to the other `stash::commands::…` entries in `invoke_handler`, add `stash::commands::stash_delete,`.

- [ ] **Step 4: Run the tests — they pass**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml remove_file_ref`
Expected: PASS (2 tests).

- [ ] **Step 5: Clippy and commit**

Run the clippy line from Task 8 Step 5 (baseline, not more), then:

```bash
git add src-tauri/src/stash/entries.rs src-tauri/src/stash/commands.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(stash): stash_delete removes a file reference (notes wait for the trash)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src-tauri/src/stash/entries.rs src-tauri/src/stash/commands.rs src-tauri/src/lib.rs
```

---

## Task 10: The menu item «Тайник» (View → Tabs), no accelerator

**Files:**
- Modify: `src-tauri/src/menu.rs` (the `tabs_submenu` builder)
- Modify: `src-tauri/src/menu_route.rs` (test list)
- Modify: `src/lib/tauri/events.ts` (`MenuAction`)

The strings were added in Task 2 (`menu.view.toggle_stash`).

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/menu_route.rs`, test `document_actions_go_to_one_window`, add `"toggle_stash"` to the list after `"toggle_drawer"`:

```rust
            "prev_tab", "select_tab_1", "select_tab_9", "toggle_drawer", "toggle_stash",
```

- [ ] **Step 2: Run it — it passes already (Focused is the default)**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml menu_route`
Expected: PASS. It pins the route; the item itself is tested by Task 14's vitest (it reads `menu.rs`).

- [ ] **Step 3: Add the item**

In `src-tauri/src/menu.rs`, in the `tabs_submenu` builder, right after the `toggle_drawer` item (`.accelerator("CmdOrCtrl+J") … .build(app)?, )`), insert:

```rust
        // The stash drawer (stash stage 04). No accelerator on purpose: ⌃S is
        // a page key — a Ctrl-only key equivalent never fires from the
        // keyboard while a window is key (see next_tab below) — handled in
        // `src/lib/stash/stash-keys.ts`.
        .item(&MenuItemBuilder::with_id("toggle_stash", t("menu.view.toggle_stash")).build(app)?)
```

In `src/lib/tauri/events.ts`, in `MenuAction`, after `| 'toggle_drawer'` add:

```ts
  | 'toggle_stash'
```

- [ ] **Step 4: Build and run the Rust tests**

Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml menu`
Expected: PASS (the menu builds in its own tests; the i18n key exists in `native.json`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/menu.rs src-tauri/src/menu_route.rs src/lib/tauri/events.ts
git commit -m "$(cat <<'EOF'
feat(stash): View → Tabs → Stash menu item (⌃S stays a page key)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src-tauri/src/menu.rs src-tauri/src/menu_route.rs src/lib/tauri/events.ts
```

---

## Task 11: Types, IPC wrappers, `tab-pull`, and the per-window store

**Files:**
- Modify: `src/lib/stash/types.ts`, `src/lib/stash/ipc.ts`
- Create: `src/lib/stash/ipc.test.ts`
- Modify: `src/lib/tauri/events.ts` (`onTabPull`)
- Create: `src/lib/stash/stash-store.svelte.ts`, `src/lib/stash/stash-store.svelte.test.ts`

- [ ] **Step 1: Types**

Append to `src/lib/stash/types.ts` every declaration below that stage 03 did not already make (Task 0 listed them):

```ts
/** `stash_counts` (roadmap). */
export interface StashCounts {
  total: number;
  stashedToday: number;
  deleted: number;
}

/** `stash_list` arguments (roadmap). */
export interface StashListArgs {
  repo?: string;
  tag?: string;
  kind?: StashKind;
  sort?: 'changed' | 'opened' | 'kind';
  deleted?: boolean;
  limit?: number;
  cursor?: string;
}

export interface StashListPage {
  entries: StashEntry[];
  total: number;
  nextCursor: string | null;
}

/** `stash_tag`'s change. */
export interface TagChange {
  add?: string[];
  remove?: string[];
}

/** `tab_holders` (stash stage 04): the other window holding an entry's file. */
export interface TabHolder {
  label: string;
  number: number | null;
}

/** `tab_request_move` (stash stage 04). */
export type PullAnswer =
  | { kind: 'not-open' }
  | { kind: 'this-window'; tabId: string }
  | { kind: 'requested'; label: string; number: number | null };
```

- [ ] **Step 2: Write the failing IPC test**

`src/lib/stash/ipc.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { LIST_MAX_PAGES, LIST_PAGE, listAllEntries } from './ipc';
import type { StashEntry, StashListArgs, StashListPage } from './types';

const e = (id: string) => ({ id }) as unknown as StashEntry;

describe('listAllEntries', () => {
  it('follows the cursor until it runs out, asking for live entries only', async () => {
    const page = vi.fn(async (args: StashListArgs): Promise<StashListPage> => {
      if (!args.cursor) return { entries: [e('a'), e('b')], total: 3, nextCursor: 'c1' };
      return { entries: [e('c')], total: 3, nextCursor: null };
    });
    expect((await listAllEntries(page)).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(page).toHaveBeenNthCalledWith(1, { limit: LIST_PAGE, cursor: undefined, deleted: false });
    expect(page).toHaveBeenNthCalledWith(2, { limit: LIST_PAGE, cursor: 'c1', deleted: false });
  });

  it('stops after LIST_MAX_PAGES even if the cursor never ends', async () => {
    const page = vi.fn(async (): Promise<StashListPage> => ({ entries: [e('x')], total: 1, nextCursor: 'again' }));
    await listAllEntries(page);
    expect(page).toHaveBeenCalledTimes(LIST_MAX_PAGES);
  });
});
```

Run: `npx vitest run src/lib/stash/ipc.test.ts` — Expected: FAIL (`listAllEntries` missing).

- [ ] **Step 3: The wrappers**

Append to `src/lib/stash/ipc.ts`. Each function below whose command already has a stage-03 wrapper (under any name, Task 0) is **not** added; use that wrapper wherever this plan calls the name given here. The imports go at the top if missing.

```ts
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type {
  PullAnswer,
  PutAwayResult,
  StashCounts,
  StashEntry,
  StashListArgs,
  StashListPage,
  TabHolder,
  TagChange,
} from './types';

// --- stage 02/03 commands: add only the ones stage 03 did not wrap ---

export function stashList(args: StashListArgs): Promise<StashListPage> {
  return invoke<StashListPage>('stash_list', { ...args });
}

export function stashPutAway(args: {
  paths: string[];
  caret?: number;
  topLine?: number;
  tags?: string[];
}): Promise<PutAwayResult[]> {
  return invoke<PutAwayResult[]>('stash_put_away', args);
}

export function stashTag(args: { id: string } & TagChange): Promise<StashEntry> {
  return invoke<StashEntry>('stash_tag', args);
}

export function stashCounts(args: { repo?: string } = {}): Promise<StashCounts> {
  return invoke<StashCounts>('stash_counts', args);
}

export function stashTouchOpened(path: string): Promise<void> {
  return invoke<void>('stash_touch_opened', { path });
}

/** `stash-changed`, through this window (CLAUDE.md: a global listener also gets targeted emits). */
export function onStashChanged(handler: (reason: string) => void): Promise<() => void> {
  return getCurrentWebviewWindow().listen<{ reason: string }>('stash-changed', (event) => handler(event.payload.reason));
}

// --- stash stage 04 ---

export function stashDelete(id: string): Promise<void> {
  return invoke<void>('stash_delete', { id });
}

export function tabHolders(paths: string[]): Promise<(TabHolder | null)[]> {
  return invoke<(TabHolder | null)[]>('tab_holders', { paths });
}

export function requestTabMove(path: string): Promise<PullAnswer> {
  return invoke<PullAnswer>('tab_request_move', { path });
}

export function windowRepo(): Promise<string | null> {
  return invoke<string | null>('window_repo');
}

export const LIST_PAGE = 500;
/** 20 000 entries: a cursor that never ends must not spin forever. */
export const LIST_MAX_PAGES = 40;

/** The whole live stash (the drawer filters and sorts on the client, D3). */
export async function listAllEntries(
  page: (args: StashListArgs) => Promise<StashListPage> = stashList
): Promise<StashEntry[]> {
  const out: StashEntry[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < LIST_MAX_PAGES; i++) {
    const res = await page({ limit: LIST_PAGE, cursor, deleted: false });
    out.push(...res.entries);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return out;
}
```

(If stage 03's `stashList` has another name, pass it as `listAllEntries`'s default instead of `stashList`.)

Run: `npx vitest run src/lib/stash/ipc.test.ts` — Expected: PASS (2 tests).

- [ ] **Step 4: `tab-pull`**

Append to `src/lib/tauri/events.ts`:

```ts
/** Stash stage 04: another window asks for the tab holding `path` (`tab_request_move`). */
export interface TabPullRequest {
  path: string;
  /** The window label the tab should move to. */
  target: string;
}

/** Through this window, like every targeted event here. */
export function onTabPull(handler: (request: TabPullRequest) => void): Promise<() => void> {
  return getCurrentWebviewWindow().listen<TabPullRequest>('tab-pull', (event) => handler(event.payload));
}
```

- [ ] **Step 5: Write the failing store test**

`src/lib/stash/stash-store.svelte.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PULSE_MS, createStashStore, type StashStoreDeps } from './stash-store.svelte';
import type { StashEntry, TabHolder } from './types';

function entry(id: string, over: Partial<StashEntry> = {}): StashEntry {
  return {
    id,
    kind: 'note',
    path: `/n/${id}.md`,
    title: id,
    repo: null,
    branch: null,
    tags: [],
    createdAt: 0,
    modifiedAt: 0,
    stashedAt: 10,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: `# ${id}\nline of ${id}`,
    ...over,
  };
}

function deps(over: Partial<StashStoreDeps> & { entries?: StashEntry[]; repo?: string | null; holders?: (TabHolder | null)[] } = {}) {
  const entries = over.entries ?? [entry('a'), entry('b')];
  return {
    list: over.list ?? vi.fn(async () => entries),
    counts: over.counts ?? vi.fn(async () => ({ total: entries.length, stashedToday: 1, deleted: 0 })),
    holders: over.holders
      ? vi.fn(async () => over.holders ?? [])
      : vi.fn(async (paths: string[]) => paths.map((): TabHolder | null => null)),
    windowRepo: over.windowRepo ?? vi.fn(async () => over.repo ?? null),
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe('stash store', () => {
  it('opens at once and fills in: entries, indexes, counts, holders, the repo chip', async () => {
    const d = deps({ repo: 'infra', holders: [null, { label: 'editor-2', number: 7 }] });
    const s = createStashStore(d);
    s.open();
    expect(s.state.open).toBe(true);
    expect(s.state.focus).toBe('stash');
    await flush();
    expect(s.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(s.indexes.get('b')?.lines).toEqual(['b', 'line of b']);
    expect(s.counts.total).toBe(2);
    expect(s.holders.get('/n/b.md')).toEqual({ label: 'editor-2', number: 7 });
    expect(s.repo).toBe('infra');
    expect(s.state.repoChip).toBe('infra');
    expect(s.loaded).toBe(true);
  });

  it('opening an open stash only refocuses, no second load', async () => {
    const d = deps();
    const s = createStashStore(d);
    s.open();
    await flush();
    s.update((st) => ({ ...st, focus: 'tabs' }));
    s.open();
    expect(s.state.focus).toBe('stash');
    expect(d.list).toHaveBeenCalledTimes(1);
  });

  it('a slower, older reload does not overwrite a newer one', async () => {
    const first = deferred<StashEntry[]>();
    const second = deferred<StashEntry[]>();
    const list = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const s = createStashStore(deps({ list }));
    void s.reload();
    void s.reload();
    second.resolve([entry('b')]);
    await flush();
    first.resolve([entry('a')]);
    await flush();
    expect(s.entries.map((e) => e.id)).toEqual(['b']);
  });

  it('stash-changed while closed refreshes the counts only', async () => {
    const d = deps();
    const s = createStashStore(d);
    s.changed();
    await flush();
    expect(d.counts).toHaveBeenCalledTimes(1);
    expect(d.list).not.toHaveBeenCalled();
  });

  it('a card on screen put away again elsewhere pulses, then stops', async () => {
    vi.useFakeTimers();
    let stashed = 10;
    const d = deps({ list: vi.fn(async () => [entry('a', { stashedAt: stashed })]) });
    const s = createStashStore(d);
    s.open();
    await flush();
    s.setShown(['a']);
    stashed = 20;
    s.changed();
    await flush();
    expect(s.pulse.has('a')).toBe(true);
    vi.advanceTimersByTime(PULSE_MS);
    expect(s.pulse.has('a')).toBe(false);
  });

  it('upsert replaces or adds; remove drops', () => {
    const s = createStashStore(deps());
    s.upsert([entry('a'), entry('b')]);
    s.upsert([entry('a', { title: 'renamed' }), entry('c')]);
    expect(s.entries.map((e) => `${e.id}:${e.title}`)).toEqual(['a:renamed', 'b:b', 'c:c']);
    s.remove('b');
    expect(s.entries.map((e) => e.id)).toEqual(['a', 'c']);
    expect(s.indexes.has('b')).toBe(false);
  });

  it('closing keeps the entries for the next open, and the sort', async () => {
    const s = createStashStore(deps());
    s.open();
    await flush();
    s.update((st) => ({ ...st, sort: 'kind' }));
    s.close();
    expect(s.state.open).toBe(false);
    expect(s.state.sort).toBe('kind');
    expect(s.entries).toHaveLength(2);
  });
});
```

Run: `npx vitest run src/lib/stash/stash-store.svelte.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 6: The store**

`src/lib/stash/stash-store.svelte.ts`:

```ts
/**
 * One window's stash drawer state (stash stage 04): the reducer state
 * (`stash-state.ts`), the whole live stash with a search index per entry, the
 * counts for the bar, who holds what elsewhere, the window's repo, and the
 * pulse / new-tag marks. Created by `App.svelte`, passed to `TabDrawer`. Every
 * load is sequence-guarded: a slower, older answer never overwrites a newer
 * one. Failures are logged and leave the last good data on screen — the drawer
 * is a view of the database, and a failed read changes nothing in it.
 */
import { indexText, type SearchIndex } from '../tabs/drawer-filter';
import { STASH_CLOSED, closeStash, openStash, pulses, setRepoChip, type StashState } from './stash-state';
import type { StashCounts, StashEntry, TabHolder } from './types';

/** How long a card pulses (mockup `stPulse` 1.1 s, plus its 260 ms delay). */
export const PULSE_MS = 1400;
/** How long a new tag pops (mockup `tagIn` .9 s). */
export const NEW_TAG_MS = 1000;

export interface StashStoreDeps {
  /** Every live entry (`listAllEntries`). */
  list(): Promise<StashEntry[]>;
  counts(): Promise<StashCounts>;
  holders(paths: string[]): Promise<(TabHolder | null)[]>;
  windowRepo(): Promise<string | null>;
}

export function createStashStore(deps: StashStoreDeps) {
  let state = $state.raw<StashState>(STASH_CLOSED);
  let entries = $state.raw<readonly StashEntry[]>([]);
  let indexes = $state.raw<ReadonlyMap<string, SearchIndex>>(new Map());
  let counts = $state.raw<StashCounts>({ total: 0, stashedToday: 0, deleted: 0 });
  let holders = $state.raw<ReadonlyMap<string, TabHolder>>(new Map());
  let repo = $state<string | null>(null);
  let loaded = $state(false);
  let width = $state(0);
  let pulse = $state.raw<ReadonlySet<string>>(new Set());
  let newTags = $state.raw<ReadonlyMap<string, readonly string[]>>(new Map());
  /** Ids the drawer last rendered: only a card on screen can pulse. Nothing renders from it. */
  let shown: ReadonlySet<string> = new Set();
  let listSeq = 0;
  let countSeq = 0;

  function setEntries(next: readonly StashEntry[]): void {
    entries = next;
    indexes = new Map(next.map((e) => [e.id, indexText(e.preview)]));
    loaded = true;
  }

  function markPulse(ids: readonly string[]): void {
    if (ids.length === 0) return;
    pulse = new Set([...pulse, ...ids]);
    setTimeout(() => {
      pulse = new Set([...pulse].filter((id) => !ids.includes(id)));
    }, PULSE_MS);
  }

  function markNewTags(id: string, tags: readonly string[]): void {
    if (tags.length === 0) return;
    const next = new Map(newTags);
    next.set(id, tags);
    newTags = next;
    setTimeout(() => {
      if (newTags.get(id) !== tags) return;
      const after = new Map(newTags);
      after.delete(id);
      newTags = after;
    }, NEW_TAG_MS);
  }

  async function refreshCounts(): Promise<void> {
    const mine = ++countSeq;
    try {
      const next = await deps.counts();
      if (mine === countSeq) counts = next;
    } catch (err) {
      console.error('stash: counts failed', err);
    }
  }

  /** The window may have got its project since the last open; a chip that followed the old repo follows the new one. */
  async function refreshRepo(): Promise<void> {
    try {
      const next = await deps.windowRepo();
      if (next === repo) return;
      const followed = state.open && state.repoChip === repo;
      repo = next;
      if (followed) state = setRepoChip(state, next);
    } catch (err) {
      console.error('stash: window repo failed', err);
    }
  }

  async function reload(): Promise<void> {
    const mine = ++listSeq;
    try {
      const list = await deps.list();
      if (mine !== listSeq) return;
      const diff = pulses(entries, list, shown);
      setEntries(list);
      markPulse(diff.pulse);
      for (const [id, tags] of diff.newTags) markNewTags(id, tags);
      const found = await deps.holders(list.map((e) => e.path));
      if (mine !== listSeq) return;
      holders = new Map(
        list.flatMap((e, i): [string, TabHolder][] => {
          const h = found[i];
          return h ? [[e.path, h]] : [];
        })
      );
    } catch (err) {
      console.error('stash: list failed', err);
    }
  }

  return {
    get state(): StashState {
      return state;
    },
    get entries(): readonly StashEntry[] {
      return entries;
    },
    get indexes(): ReadonlyMap<string, SearchIndex> {
      return indexes;
    },
    get counts(): StashCounts {
      return counts;
    },
    get holders(): ReadonlyMap<string, TabHolder> {
      return holders;
    },
    get repo(): string | null {
      return repo;
    },
    get loaded(): boolean {
      return loaded;
    },
    /** The stash drawer's width, px, as `TabDrawer` laid it out (the toast stack moves by it). */
    get width(): number {
      return width;
    },
    get pulse(): ReadonlySet<string> {
      return pulse;
    },
    get newTags(): ReadonlyMap<string, readonly string[]> {
      return newTags;
    },
    update(fn: (s: StashState) => StashState): void {
      state = fn(state);
    },
    /** Opens at once with the last known repo; the list, counts and repo arrive after. */
    open(): void {
      const wasOpen = state.open;
      state = openStash(state, repo);
      if (wasOpen) return;
      void refreshRepo();
      void reload();
      void refreshCounts();
    },
    close(): void {
      state = closeStash(state);
    },
    reload,
    refreshCounts,
    /** `stash-changed`: the bar's counts always, the list only while it is on screen. */
    changed(): void {
      void refreshCounts();
      if (state.open) void reload();
    },
    setShown(ids: readonly string[]): void {
      shown = new Set(ids);
    },
    setWidth(px: number): void {
      width = px;
    },
    /** Entries a put-away or a tag change returned: shown at once, before `stash-changed`. */
    upsert(list: readonly StashEntry[]): void {
      if (list.length === 0) return;
      const byId = new Map(list.map((e) => [e.id, e]));
      const next = entries.map((e) => byId.get(e.id) ?? e);
      for (const e of list) if (!entries.some((x) => x.id === e.id)) next.push(e);
      setEntries(next);
    },
    remove(id: string): void {
      setEntries(entries.filter((e) => e.id !== id));
    },
    markPulse,
    markNewTags,
  };
}

export type StashStore = ReturnType<typeof createStashStore>;
```

- [ ] **Step 7: Run the tests — they pass**

Run: `npx vitest run src/lib/stash/stash-store.svelte.test.ts src/lib/stash/ipc.test.ts`
Expected: PASS (7 + 2 tests).

- [ ] **Step 8: Commit**

```bash
git add src/lib/stash/types.ts src/lib/stash/ipc.ts src/lib/stash/ipc.test.ts src/lib/tauri/events.ts src/lib/stash/stash-store.svelte.ts src/lib/stash/stash-store.svelte.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): per-window stash store, IPC wrappers for the drawer, tab-pull event

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/stash/types.ts src/lib/stash/ipc.ts src/lib/stash/ipc.test.ts src/lib/tauri/events.ts src/lib/stash/stash-store.svelte.ts src/lib/stash/stash-store.svelte.test.ts
```

---

## Task 12: Put away and open from the stash (orchestration over injected deps)

**Files:**
- Create: `src/lib/stash/put-away.ts`, `src/lib/stash/put-away.test.ts`
- Create: `src/lib/stash/open-from-stash.ts`, `src/lib/stash/open-from-stash.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/lib/stash/put-away.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { TabMeta } from '../tabs/tab-model';
import type { PutAwayResult, StashEntry } from './types';
import { putAwayNote, putAwayTabs } from './put-away';

const tab = (id: string, path: string | null): TabMeta => ({ id, path, dirty: false, openedAt: 0, viewedAt: 0, unviewed: false });

function result(id: string, kind: 'note' | 'file', created: boolean, repo: string | null = null): PutAwayResult {
  const entry = {
    id,
    kind,
    path: `/p/${id}.md`,
    title: `${id}.md`,
    repo,
    branch: null,
    tags: [],
    createdAt: 0,
    modifiedAt: 0,
    stashedAt: 1,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: '',
  } satisfies StashEntry;
  return { entry, created };
}

describe('putAwayTabs', () => {
  const tabs = [tab('a', '/p/a.md'), tab('b', null), tab('c', '/p/c.md')];

  it('one put-away for every file-backed tab, in tab order, then closes them all', async () => {
    const putAway = vi.fn(async () => [result('a', 'file', true), result('c', 'file', false)]);
    const close = vi.fn(async () => {});
    const outcome = await putAwayTabs(['c', 'b', 'a'], { tabs: () => tabs, putAway, close });
    expect(putAway).toHaveBeenCalledWith(['/p/a.md', '/p/c.md']);
    expect(close).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(outcome).toEqual({ kind: 'done', results: [result('a', 'file', true), result('c', 'file', false)], closedEmpty: 1 });
  });

  it('empty tabs are only closed', async () => {
    const putAway = vi.fn(async () => []);
    const close = vi.fn(async () => {});
    expect(await putAwayTabs(['b'], { tabs: () => tabs, putAway, close })).toEqual({ kind: 'done', results: [], closedEmpty: 1 });
    expect(putAway).not.toHaveBeenCalled();
  });

  it('a failed put-away closes nothing', async () => {
    const close = vi.fn(async () => {});
    const outcome = await putAwayTabs(['a'], {
      tabs: () => tabs,
      putAway: async () => {
        throw new Error('database is locked');
      },
      close,
    });
    expect(outcome).toEqual({ kind: 'failed', error: 'database is locked' });
    expect(close).not.toHaveBeenCalled();
  });

  it('ids that are not tabs here are ignored', async () => {
    const close = vi.fn(async () => {});
    expect(await putAwayTabs(['zzz'], { tabs: () => tabs, putAway: vi.fn(), close })).toEqual({
      kind: 'done',
      results: [],
      closedEmpty: 0,
    });
    expect(close).not.toHaveBeenCalled();
  });
});

describe('putAwayNote', () => {
  it('counts file duplicates only and what the chip hides', () => {
    const note = putAwayNote(
      { kind: 'done', results: [result('n', 'note', false, 'r'), result('f', 'file', false, 'infra'), result('g', 'file', true, 'infra')], closedEmpty: 1 },
      'r',
      'Untitled'
    );
    expect(note).toEqual({
      what: 'put-away',
      count: 3,
      dup: 1,
      lead: 'n.md',
      leadIsNote: true,
      hidden: 2,
      hiddenBy: 'r',
      onlyEmpty: false,
      emptyToo: true,
    });
  });

  it('only empty tabs', () => {
    expect(putAwayNote({ kind: 'done', results: [], closedEmpty: 2 }, null, 'Untitled')).toMatchObject({ onlyEmpty: true, count: 0 });
  });
});
```

`src/lib/stash/open-from-stash.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { PullAnswer, StashEntry } from './types';
import { openFromStash, type OpenFromStashDeps } from './open-from-stash';

const entry = { id: 's1', kind: 'file', path: '/r/a.md', title: 'a.md', repo: 'r', branch: 'main', tags: [], createdAt: 0, modifiedAt: 0, stashedAt: 1, openedAt: null, deletedAt: null, caret: 42, topLine: 7, preview: '' } satisfies StashEntry;

function deps(answer: PullAnswer, has = true): OpenFromStashDeps & Record<string, ReturnType<typeof vi.fn>> {
  return {
    requestMove: vi.fn(async () => answer),
    activate: vi.fn(async () => {}),
    openPath: vi.fn(async () => {}),
    has: vi.fn(() => has),
    place: vi.fn(),
    touch: vi.fn(async () => {}),
  };
}

describe('openFromStash', () => {
  it('already a tab here: shows it', async () => {
    const d = deps({ kind: 'this-window', tabId: 't9' });
    expect(await openFromStash(entry, undefined, d)).toEqual({ kind: 'activated' });
    expect(d.activate).toHaveBeenCalledWith('t9');
    expect(d.openPath).not.toHaveBeenCalled();
    expect(d.touch).toHaveBeenCalledWith('/r/a.md');
  });

  it('held elsewhere: asked to move here, nothing opened here', async () => {
    const d = deps({ kind: 'requested', label: 'editor-19', number: 19 });
    expect(await openFromStash(entry, undefined, d)).toEqual({ kind: 'pulled', label: 'editor-19', number: 19 });
    expect(d.openPath).not.toHaveBeenCalled();
  });

  it('free: opened at its caret, placed where it was dropped', async () => {
    const d = deps({ kind: 'not-open' });
    expect(await openFromStash(entry, 'tab-3', d)).toEqual({ kind: 'opened' });
    expect(d.openPath).toHaveBeenCalledWith('/r/a.md', { cursor: 42, topLine: 7 });
    expect(d.place).toHaveBeenCalledWith('/r/a.md', 'tab-3');
    expect(d.touch).toHaveBeenCalledWith('/r/a.md');
  });

  it('a click (no drop position) is not re-placed; a drop at the end is', async () => {
    const d = deps({ kind: 'not-open' });
    await openFromStash(entry, undefined, d);
    expect(d.place).not.toHaveBeenCalled();
    await openFromStash(entry, null, d);
    expect(d.place).toHaveBeenCalledWith('/r/a.md', null);
  });

  it('an open that did not land (the open-error toast is already up) reports failure silently', async () => {
    const d = deps({ kind: 'not-open' }, false);
    expect(await openFromStash(entry, 'tab-3', d)).toEqual({ kind: 'failed', error: null });
    expect(d.place).not.toHaveBeenCalled();
    expect(d.touch).not.toHaveBeenCalled();
  });

  it('a failed request says why', async () => {
    const d = deps({ kind: 'not-open' });
    d.requestMove.mockRejectedValueOnce(new Error('no window'));
    expect(await openFromStash(entry, undefined, d)).toEqual({ kind: 'failed', error: 'no window' });
  });
});
```

- [ ] **Step 2: Run them — they fail**

Run: `npx vitest run src/lib/stash/put-away.test.ts src/lib/stash/open-from-stash.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`src/lib/stash/put-away.ts`:

```ts
/**
 * «Отложить» for tabs of this window (stash stage 04, D8): one
 * `stash_put_away` for every file-backed tab — one database transaction —
 * then the ⌘W path for each (`controller.closeTabs`), so the dirty checks,
 * the neighbour choice and ⌘⇧T all apply as for any close. A tab with no path
 * is an empty new tab (stage 03 made every tab with text a note): it is only
 * closed, and vanishes. Nothing is closed if the put-away failed.
 */
import type { TabMeta } from '../tabs/tab-model';
import type { StashToastNote } from './stash-toast';
import { entryTitle } from './stash-view';
import type { PutAwayResult } from './types';

export interface PutAwayDeps {
  /** This window's tabs, in order, now. */
  tabs(): readonly TabMeta[];
  putAway(paths: string[]): Promise<PutAwayResult[]>;
  close(ids: string[]): Promise<void>;
}

export type PutAwayOutcome =
  | { kind: 'done'; results: PutAwayResult[]; closedEmpty: number }
  | { kind: 'failed'; error: string };

export async function putAwayTabs(ids: readonly string[], deps: PutAwayDeps): Promise<PutAwayOutcome> {
  const wanted = new Set(ids);
  const chosen = deps.tabs().filter((tab) => wanted.has(tab.id));
  if (chosen.length === 0) return { kind: 'done', results: [], closedEmpty: 0 };
  const paths = chosen.flatMap((tab) => (tab.path === null ? [] : [tab.path]));
  let results: PutAwayResult[] = [];
  if (paths.length > 0) {
    try {
      results = await deps.putAway(paths);
    } catch (err) {
      return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }
  await deps.close(chosen.map((tab) => tab.id));
  return { kind: 'done', results, closedEmpty: chosen.length - paths.length };
}

/** The toast for a finished put-away. `repoChip`: the chip on screen now, if the stash is open. */
export function putAwayNote(
  outcome: Extract<PutAwayOutcome, { kind: 'done' }>,
  repoChip: string | null,
  untitled: string
): StashToastNote {
  const { results, closedEmpty } = outcome;
  const lead = results[0]?.entry ?? null;
  const hidden = repoChip === null ? 0 : results.filter((r) => r.entry.repo !== repoChip).length;
  return {
    what: 'put-away',
    count: results.length,
    dup: results.filter((r) => !r.created && r.entry.kind === 'file').length,
    lead: lead ? entryTitle(lead, untitled) : null,
    leadIsNote: lead?.kind === 'note',
    hidden,
    hiddenBy: hidden > 0 ? repoChip : null,
    onlyEmpty: results.length === 0 && closedEmpty > 0,
    emptyToo: results.length > 0 && closedEmpty > 0,
  };
}
```

`src/lib/stash/open-from-stash.ts`:

```ts
/**
 * Stash → tabs (stash stage 04, D9; spec «Перенос»). `tab_request_move`
 * decides in one IPC: this window has it → show that tab; another window has
 * it → that window was asked (`tab-pull`) to move it here, and the caller
 * watches for it (`PULL_WAIT_MS`); nobody has it → open it here at its caret
 * and, for a drop, put it where it was dropped. `stash_touch_opened` after
 * every success («открытие» sort).
 */
import type { PullAnswer, StashEntry } from './types';

/** How long a pulled tab has to arrive before the human is told it did not. */
export const PULL_WAIT_MS = 4000;

export interface OpenFromStashDeps {
  requestMove(path: string): Promise<PullAnswer>;
  activate(tabId: string): Promise<void>;
  openPath(path: string, position: { cursor: number; topLine: number }): Promise<void>;
  /** The path is a tab here now. */
  has(path: string): boolean;
  /** Put the tab holding `path` before tab `before` (`null`: last). */
  place(path: string, before: string | null): void;
  touch(path: string): Promise<void>;
}

export type StashOpened =
  | { kind: 'activated' }
  | { kind: 'opened' }
  | { kind: 'pulled'; label: string; number: number | null }
  /** `error: null` — the open's own toast (`open-error`) already said why. */
  | { kind: 'failed'; error: string | null };

/** `before`: `undefined` — a click or Enter (after the active tab, as any open); else the drop position. */
export async function openFromStash(
  entry: StashEntry,
  before: string | null | undefined,
  deps: OpenFromStashDeps
): Promise<StashOpened> {
  let answer: PullAnswer;
  try {
    answer = await deps.requestMove(entry.path);
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
  const touch = (): void => {
    deps.touch(entry.path).catch((err: unknown) => console.error('stash: touch failed', err));
  };
  if (answer.kind === 'this-window') {
    await deps.activate(answer.tabId);
    touch();
    return { kind: 'activated' };
  }
  if (answer.kind === 'requested') {
    touch();
    return { kind: 'pulled', label: answer.label, number: answer.number };
  }
  await deps.openPath(entry.path, { cursor: entry.caret, topLine: entry.topLine });
  if (!deps.has(entry.path)) return { kind: 'failed', error: null };
  if (before !== undefined) deps.place(entry.path, before);
  touch();
  return { kind: 'opened' };
}
```

- [ ] **Step 4: Run them — they pass**

Run: `npx vitest run src/lib/stash/put-away.test.ts src/lib/stash/open-from-stash.test.ts`
Expected: PASS (6 + 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stash/put-away.ts src/lib/stash/put-away.test.ts src/lib/stash/open-from-stash.ts src/lib/stash/open-from-stash.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): put-away and open-from-stash orchestration

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/stash/put-away.ts src/lib/stash/put-away.test.ts src/lib/stash/open-from-stash.ts src/lib/stash/open-from-stash.test.ts
```

---

## Task 13: The window widens for the stash, and goes back

**Files:**
- Create: `src/lib/stash/window-widen.ts`, `src/lib/stash/window-widen.test.ts`
- Modify: `src-tauri/capabilities/default.json`

`@tauri-apps/api` 2.10's `window` module has everything: `getCurrentWindow()` (`isFullscreen`, `scaleFactor`, `innerSize`, `outerSize`, `outerPosition`, `setSize`, `setPosition`), `currentMonitor()` with `workArea` (physical), `LogicalSize`, `LogicalPosition`. The getters are in `core:window:default` (part of `core:default`); only the two setters need grants. Confirm the API with context7 (`/tauri-apps/tauri-docs`, "Window setSize setPosition currentMonitor workArea") before writing, as the project rules require.

- [ ] **Step 1: Write the failing test**

`src/lib/stash/window-widen.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('@tauri-apps/api/window', () => {
  class LogicalSize {
    constructor(
      public width: number,
      public height: number
    ) {}
  }
  class LogicalPosition {
    constructor(
      public x: number,
      public y: number
    ) {}
  }
  const size = (w: number, h: number) => ({ width: w, height: h, toLogical: (s: number) => ({ width: w / s, height: h / s }) });
  const pos = (x: number, y: number) => ({ x, y, toLogical: (s: number) => ({ x: x / s, y: y / s }) });
  const win = {
    isFullscreen: vi.fn(async () => false),
    scaleFactor: vi.fn(async () => 2),
    innerSize: vi.fn(async () => size(1120, 1400)),
    outerSize: vi.fn(async () => size(1120, 1456)),
    outerPosition: vi.fn(async () => pos(200, 100)),
    setSize: vi.fn(async () => {}),
    setPosition: vi.fn(async () => {}),
  };
  return {
    LogicalSize,
    LogicalPosition,
    getCurrentWindow: () => win,
    currentMonitor: vi.fn(async () => ({ scaleFactor: 2, workArea: { position: pos(0, 50), size: size(2880, 1700) } })),
    __win: win,
    __size: size,
    __pos: pos,
  };
});

import * as tauriWindow from '@tauri-apps/api/window';
import { restoreWindow, widenForStash } from './window-widen';

interface Fake {
  __win: Record<'isFullscreen' | 'scaleFactor' | 'innerSize' | 'outerSize' | 'outerPosition' | 'setSize' | 'setPosition', ReturnType<typeof vi.fn>>;
  __size: (w: number, h: number) => unknown;
  __pos: (x: number, y: number) => unknown;
}
const fake = tauriWindow as unknown as Fake;
const w = fake.__win;
const globals = window as unknown as Record<string, unknown>;

beforeEach(() => {
  globals.__TAURI_INTERNALS__ = {};
  for (const fn of Object.values(w)) fn.mockClear();
});
afterEach(() => {
  delete globals.__TAURI_INTERNALS__;
});

describe('widenForStash', () => {
  it('a 560 px window grows to 680 in place', async () => {
    const memo = await widenForStash(560);
    expect(w.setPosition).not.toHaveBeenCalled();
    expect(w.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 680, height: 700 }));
    expect(memo).toEqual({ before: { width: 560, height: 700, x: 100, y: 50 }, widened: { width: 680, height: 700 }, at: null });
  });

  it('at the right edge it moves left first', async () => {
    w.outerPosition.mockResolvedValueOnce(fake.__pos(2400, 100));
    const memo = await widenForStash(560);
    expect(w.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 760, y: 50 }));
    expect(w.setPosition.mock.invocationCallOrder[0]).toBeLessThan(w.setSize.mock.invocationCallOrder[0]);
    expect(memo?.at).toEqual({ x: 760, y: 50 });
  });

  it('leaves a fullscreen window, a wide one, and the browser alone', async () => {
    w.isFullscreen.mockResolvedValueOnce(true);
    expect(await widenForStash(560)).toBeNull();
    expect(await widenForStash(700)).toBeNull();
    delete globals.__TAURI_INTERNALS__;
    expect(await widenForStash(560)).toBeNull();
    expect(w.setSize).not.toHaveBeenCalled();
  });
});

describe('restoreWindow', () => {
  const memo = { before: { width: 560, height: 700, x: 1100, y: 50 }, widened: { width: 680, height: 700 }, at: { x: 760, y: 50 } };

  it('puts size and place back while the window is still as widened', async () => {
    w.innerSize.mockResolvedValueOnce(fake.__size(1360, 1400));
    w.outerPosition.mockResolvedValueOnce(fake.__pos(1520, 100));
    await restoreWindow(memo);
    expect(w.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 560, height: 700 }));
    expect(w.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 1100, y: 50 }));
  });

  it('keeps a resize the human made meanwhile', async () => {
    w.innerSize.mockResolvedValueOnce(fake.__size(1500, 1400));
    await restoreWindow(memo);
    expect(w.setSize).not.toHaveBeenCalled();
  });

  it('keeps the place if the human moved the window', async () => {
    w.innerSize.mockResolvedValueOnce(fake.__size(1360, 1400));
    w.outerPosition.mockResolvedValueOnce(fake.__pos(300, 300));
    await restoreWindow(memo);
    expect(w.setSize).toHaveBeenCalled();
    expect(w.setPosition).not.toHaveBeenCalled();
  });
});

describe('capabilities', () => {
  it('grant the two setters — without them the IPC is rejected silently', () => {
    const file = fileURLToPath(new URL('../../../src-tauri/capabilities/default.json', import.meta.url));
    const permissions = (JSON.parse(readFileSync(file, 'utf8')) as { permissions: string[] }).permissions;
    expect(permissions).toContain('core:window:allow-set-size');
    expect(permissions).toContain('core:window:allow-set-position');
  });
});
```

- [ ] **Step 2: Run it — it fails**

Run: `npx vitest run src/lib/stash/window-widen.test.ts`
Expected: FAIL — `./window-widen` missing.

- [ ] **Step 3: Implement**

`src/lib/stash/window-widen.ts`:

```ts
/**
 * Stash stage 04 (spec «Уже 680px», D15): while the stash is open a window too
 * narrow for both drawers widens itself — moving left first at the work
 * area's right edge — and goes back when the stash closes. Fullscreen (Split
 * View is a fullscreen space) is left alone. The numbers are `planWiden`'s;
 * this file only reads and moves the window. In the browser (`npm run dev`,
 * no Tauri) it does nothing.
 *
 * Needs `core:window:allow-set-size` and `core:window:allow-set-position` in
 * `capabilities/default.json`: without them the IPC is rejected and — as the
 * zoom was before it (CLAUDE.md) — the feature is silently dead. The test
 * reads the capability file.
 */
import { LogicalPosition, LogicalSize, currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { planWiden, stillWidened, type Size } from './drawer-width';

export interface WidenMemo {
  /** Inner size and outer position before, logical px. */
  before: Size & { x: number; y: number };
  /** The inner size it was widened to: put back only while it still is. */
  widened: Size;
  /** Where it was moved to, or `null` if it was not moved. */
  at: { x: number; y: number } | null;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function near(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
}

export async function widenForStash(viewport: number = window.innerWidth): Promise<WidenMemo | null> {
  if (!inTauri()) return null;
  try {
    const win = getCurrentWindow();
    if (await win.isFullscreen()) return null;
    const [scale, innerP, outerP, posP, monitor] = await Promise.all([
      win.scaleFactor(),
      win.innerSize(),
      win.outerSize(),
      win.outerPosition(),
      currentMonitor(),
    ]);
    if (!monitor) return null;
    const inner = innerP.toLogical(scale);
    const outer = outerP.toLogical(scale);
    const pos = posP.toLogical(scale);
    const waPos = monitor.workArea.position.toLogical(monitor.scaleFactor);
    const waSize = monitor.workArea.size.toLogical(monitor.scaleFactor);
    const plan = planWiden({
      viewport,
      inner: { width: inner.width, height: inner.height },
      outer: { x: pos.x, y: pos.y, width: outer.width, height: outer.height },
      workArea: { x: waPos.x, y: waPos.y, width: waSize.width, height: waSize.height },
    });
    if (!plan) return null;
    // Move first, then grow: the frame never pokes past the screen edge.
    if (plan.position) await win.setPosition(new LogicalPosition(plan.position.x, plan.position.y));
    await win.setSize(new LogicalSize(plan.inner.width, plan.inner.height));
    return {
      before: { width: inner.width, height: inner.height, x: pos.x, y: pos.y },
      widened: plan.inner,
      at: plan.position,
    };
  } catch (err) {
    console.error('stash: could not widen the window', err);
    return null;
  }
}

/** Shrink first, then move back — and each only if the human did not change it meanwhile. */
export async function restoreWindow(memo: WidenMemo): Promise<void> {
  if (!inTauri()) return;
  try {
    const win = getCurrentWindow();
    const scale = await win.scaleFactor();
    const now = (await win.innerSize()).toLogical(scale);
    if (!stillWidened({ width: now.width, height: now.height }, memo.widened)) return;
    await win.setSize(new LogicalSize(memo.before.width, memo.before.height));
    if (memo.at === null) return;
    const pos = (await win.outerPosition()).toLogical(scale);
    if (near({ x: pos.x, y: pos.y }, memo.at)) await win.setPosition(new LogicalPosition(memo.before.x, memo.before.y));
  } catch (err) {
    console.error('stash: could not restore the window', err);
  }
}
```

In `src-tauri/capabilities/default.json`, after `"core:window:allow-center",` add:

```json
    "core:window:allow-set-size",
    "core:window:allow-set-position",
```

- [ ] **Step 4: Run it — it passes; the capability builds**

Run: `npx vitest run src/lib/stash/window-widen.test.ts`
Expected: PASS (7 tests).
Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo check --manifest-path src-tauri/Cargo.toml`
Expected: builds (`tauri-build` validates the capability file).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stash/window-widen.ts src/lib/stash/window-widen.test.ts src-tauri/capabilities/default.json
git commit -m "$(cat <<'EOF'
feat(stash): widen a narrow window for the stash and restore it on close

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/stash/window-widen.ts src/lib/stash/window-widen.test.ts src-tauri/capabilities/default.json
```

---

## Task 14: ⌃S — a page key that toggles the stash

**Files:**
- Modify: `src/lib/stash/stash-keys.ts` (append)
- Create: `src/lib/stash/stash-keys.ctrl-s.test.ts` (a file of its own: stage 03 owns `stash-keys.test.ts`)

- [ ] **Step 1: Write the failing test**

`src/lib/stash/stash-keys.ctrl-s.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ctrlSHandler, isCtrlS } from './stash-keys';
import { NATIVE_MENU_ACCELERATORS } from '../editor/native-menu-accelerators';

const MENU_RS = fileURLToPath(new URL('../../../src-tauri/src/menu.rs', import.meta.url));

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 's', code: 'KeyS', bubbles: true, cancelable: true, ...init });
}

describe('isCtrlS', () => {
  it('is ⌃S alone, on the physical key', () => {
    expect(isCtrlS(keydown({ ctrlKey: true }))).toBe(true);
    expect(isCtrlS(keydown({ ctrlKey: true, key: 'ы' }))).toBe(true);
    expect(isCtrlS(keydown({ metaKey: true }))).toBe(false);
    expect(isCtrlS(keydown({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isCtrlS(keydown({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isCtrlS(keydown({ ctrlKey: true, code: 'KeyT', key: 't' }))).toBe(false);
  });
});

describe('ctrlSHandler', () => {
  const later = vi.fn();
  let handler: (e: KeyboardEvent) => void;
  afterEach(() => {
    window.removeEventListener('keydown', handler, true);
    window.removeEventListener('keydown', later, true);
    later.mockClear();
  });

  it('toggles once and keeps the key from the drawer and the editor', () => {
    const toggle = vi.fn();
    handler = ctrlSHandler(toggle);
    window.addEventListener('keydown', handler, true);
    window.addEventListener('keydown', later, true);
    const e = keydown({ ctrlKey: true });
    document.body.dispatchEvent(e);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
  });

  it('ignores auto-repeat, or a held key would flap the drawer', () => {
    const toggle = vi.fn();
    handler = ctrlSHandler(toggle);
    window.addEventListener('keydown', handler, true);
    const e = keydown({ ctrlKey: true, repeat: true });
    document.body.dispatchEvent(e);
    expect(toggle).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it('lets every other key through', () => {
    const toggle = vi.fn();
    handler = ctrlSHandler(toggle);
    window.addEventListener('keydown', handler, true);
    window.addEventListener('keydown', later, true);
    document.body.dispatchEvent(keydown({ metaKey: true }));
    expect(toggle).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledTimes(1);
  });
});

describe('the menu never claims ⌃S or ⌃T', () => {
  it('no native accelerator is Ctrl+S / Ctrl+T (the page handlers would never see the key)', () => {
    const ctrl = new Set(['Ctrl+S', 'Control+S', 'Ctrl+T', 'Control+T']);
    for (const a of NATIVE_MENU_ACCELERATORS) expect(ctrl.has(a.accelerator), a.id).toBe(false);
    const claimed = [...readFileSync(MENU_RS, 'utf8').matchAll(/\.accelerator\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
    expect(claimed.length).toBeGreaterThan(5);
    for (const accelerator of claimed) expect(ctrl.has(accelerator), accelerator).toBe(false);
  });

  it('the «Тайник» item exists and carries no accelerator', () => {
    expect(readFileSync(MENU_RS, 'utf8')).toMatch(
      /with_id\("toggle_stash", t\("menu\.view\.toggle_stash"\)\)\s*\.build\(app\)/
    );
  });
});
```

- [ ] **Step 2: Run it — it fails**

Run: `npx vitest run src/lib/stash/stash-keys.ctrl-s.test.ts`
Expected: FAIL — `ctrlSHandler` / `isCtrlS` not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/stash/stash-keys.ts`:

```ts
/** ⌃S alone (no ⌘/⌥/⇧), matched on the physical key (spec «Клавиатура»). */
export function isCtrlS(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyS';
}

/**
 * ⌃S: open or close the stash from anywhere — from a closed drawer it opens
 * both, the stash with the keys (spec). A page key for the reason ⌃T is one: a
 * Ctrl-only menu accelerator never fires from the keyboard (CLAUDE.md,
 * measured 2026-09-25). Registered in the capture phase on `window` right
 * after the ⌃T handler, so neither the drawer nor CodeMirror sees it.
 * Auto-repeat is swallowed but ignored: a held ⌃S would flap the drawer.
 */
export function ctrlSHandler(toggle: () => void): (e: KeyboardEvent) => void {
  return (e) => {
    if (!isCtrlS(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) toggle();
  };
}
```

- [ ] **Step 4: Run it — it passes**

Run: `npx vitest run src/lib/stash/stash-keys.ctrl-s.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stash/stash-keys.ts src/lib/stash/stash-keys.ctrl-s.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): ⌃S page handler toggles the stash; guard menu.rs against Ctrl+S/T

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/stash/stash-keys.ts src/lib/stash/stash-keys.ctrl-s.test.ts
```

---

## Task 15: Icons and the stash card

**Files:**
- Create: `src/lib/stash/icons.ts`, `src/lib/stash/StashIcon.svelte`
- Create: `src/lib/stash/StashCard.svelte`, `src/lib/stash/StashCard.svelte.test.ts`

- [ ] **Step 1: Icons (no test of their own — the card test renders them)**

`src/lib/stash/icons.ts` (paths from the mockup's `ICONS`; the note's `<rect>` is written as a path so every icon is paths only):

```ts
/**
 * The stash's glyphs (mockup `ICONS`, 16×16, stroked): the tray is the stash
 * itself, a note is a sheet couplet owns, a file ref is a sheet with an arrow
 * out, the repo is a folder. If stage 03 exports its own tray path, import it
 * here instead of repeating it (Task 0 Step 3).
 */
export type StashIconName = 'tray' | 'note' | 'fref' | 'repo';

export const STASH_ICONS: Record<StashIconName, readonly string[]> = {
  tray: [
    'M2.5 9.5 4.2 3.5h7.6l1.7 6',
    'M2.5 9.5v3.2c0 .4.3.8.8.8h9.4c.5 0 .8-.4.8-.8V9.5h-3.3l-.9 1.6H6.7l-.9-1.6z',
  ],
  note: [
    'M4.8 2.5h6.4c.72 0 1.3.58 1.3 1.3v8.4c0 .72-.58 1.3-1.3 1.3H4.8c-.72 0-1.3-.58-1.3-1.3V3.8c0-.72.58-1.3 1.3-1.3z',
    'M6 6h4M6 8.5h4M6 11h2.4',
  ],
  fref: ['M8 2.5H4.8c-.7 0-1.3.6-1.3 1.3v8.4c0 .7.6 1.3 1.3 1.3h6.4c.7 0 1.3-.6 1.3-1.3V9', 'M10.5 2.5h3v3M13.5 2.5 8.5 7.5'],
  repo: ['M2.5 4.3c0-.5.4-.8.8-.8h3l1.3 1.5h5.1c.5 0 .8.4.8.8v6.4c0 .5-.3.8-.8.8H3.3c-.4 0-.8-.3-.8-.8z'],
};
```

`src/lib/stash/StashIcon.svelte`:

```svelte
<script lang="ts">
  import { STASH_ICONS, type StashIconName } from './icons';

  let { name, stroke = 1.5 }: { name: StashIconName; stroke?: number } = $props();
</script>

<svg
  class="ico"
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each STASH_ICONS[name] as d (d)}<path {d} />{/each}
</svg>

<style>
  .ico {
    width: 1em;
    height: 1em;
    display: inline-block;
    flex: 0 0 auto;
  }
</style>
```

- [ ] **Step 2: Write the failing card test**

`src/lib/stash/StashCard.svelte.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { installCatalog } from '../i18n';
import StashCard from './StashCard.svelte';
import type { StashEntry, TabHolder } from './types';

const NOW = new Date(2026, 8, 26, 10, 30).getTime();

function entry(over: Partial<StashEntry> = {}): StashEntry {
  return {
    id: 'f1',
    kind: 'file',
    path: '/Users/x/dev/infra/oncall/rota.md',
    title: 'rota.md',
    repo: 'infra',
    branch: 'main',
    tags: ['ops'],
    createdAt: NOW - 9_000_000,
    modifiedAt: NOW - 8_000_000,
    stashedAt: NOW - 3_600_000,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: '# Rota\n- week 40 — Alex',
    ...over,
  };
}

let target: HTMLElement;
let component: ReturnType<typeof mount> | null = null;
const spies = {
  onremove: vi.fn(),
  onfilter: vi.fn(),
  onsettag: vi.fn(),
  ondone: vi.fn(),
  onhoverstart: vi.fn(),
  onhoverend: vi.fn(),
};

function render(e: StashEntry, holder: TabHolder | null = null): HTMLElement {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(StashCard, {
    target,
    props: {
      entry: e,
      title: e.title ?? 'Без названия',
      match: { rank: 0 },
      query: '',
      holder,
      kb: false,
      expanded: false,
      dragging: false,
      compact: false,
      pulse: false,
      newTags: [],
      now: NOW,
      ...spies,
    },
  });
  flushSync();
  return target.querySelector<HTMLElement>('.card')!;
}

function q(card: HTMLElement, sel: string): HTMLElement | null {
  return card.querySelector<HTMLElement>(sel);
}

beforeEach(() => installCatalog('ru'));
afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
  for (const s of Object.values(spies)) s.mockClear();
  installCatalog('en');
});

describe('StashCard', () => {
  it('a file ref: remove action, «отложено», repo/branch, path, a dashed repo chip', () => {
    const card = render(entry());
    expect(q(card, '.card-rm')?.textContent).toBe('убрать из тайника');
    expect(q(card, '.card-meta .aw')?.textContent).toBe('отложено сегодня 09:30');
    expect(q(card, '.card-meta')?.textContent).toContain('infra');
    expect(q(card, '.card-meta .br')?.textContent).toBe('⎇ main');
    expect(q(card, '.card-path')?.textContent).toBe('oncall/rota.md');
    expect(q(card, '.tag.repo')?.textContent).toContain('infra');
    expect(q(card, '.tag.repo .tag-x')).toBeNull();
    expect(q(card, '.tag:not(.repo) .tag-b')?.textContent).toBe('#ops');
  });

  it('a note: no remove action (stage 06), the note line, the title line dropped from the preview', () => {
    const card = render(entry({ kind: 'note', title: 'Rota', repo: null, branch: null, path: '/d/n.md' }));
    expect(q(card, '.card-rm')).toBeNull();
    expect(q(card, '.card-path')).toBeNull();
    expect(q(card, '.card-meta')?.textContent).toContain('заметка ·');
    expect(q(card, '.card-preview')?.textContent).not.toContain('Rota');
    expect(q(card, '.card-preview')?.textContent).toContain('week 40');
  });

  it('says which window has it open', () => {
    expect(q(render(entry(), { label: 'editor-19', number: 19 }), '.open-mark')?.textContent).toBe('открыт в #19');
  });

  it('a note open elsewhere reads in the feminine', () => {
    const card = render(entry({ kind: 'note' }), { label: 'editor-19', number: 19 });
    expect(q(card, '.open-mark')?.textContent).toBe('открыта в #19');
  });

  it('adds a normalized tag on Enter', async () => {
    const card = render(entry());
    q(card, '.tag-add')!.click();
    await tick();
    const input = q(card, '.tag-edit') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    input.value = ' #Deploy Plan ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    flushSync();
    expect(spies.onsettag).toHaveBeenCalledWith({ add: ['deploy-plan'] });
    expect(spies.ondone).toHaveBeenCalled();
    expect(q(card, '.tag-edit')).toBeNull();
  });

  it('Esc cancels the tag and its keys stay in the input', async () => {
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    const card = render(entry());
    q(card, '.tag-add')!.click();
    await tick();
    const input = q(card, '.tag-edit') as HTMLInputElement;
    input.value = 'x';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    flushSync();
    expect(spies.onsettag).not.toHaveBeenCalled();
    expect(outside).not.toHaveBeenCalled();
    window.removeEventListener('keydown', outside);
  });

  it('a chip filters; its × removes the tag; the remove action removes the ref', () => {
    const card = render(entry());
    q(card, '.tag:not(.repo) .tag-b')!.click();
    expect(spies.onfilter).toHaveBeenCalledWith('ops');
    q(card, '.tag:not(.repo) .tag-x')!.click();
    expect(spies.onsettag).toHaveBeenCalledWith({ remove: ['ops'] });
    q(card, '.tag.repo')!.click();
    expect(spies.onfilter).toHaveBeenCalledWith('infra');
    q(card, '.card-rm')!.click();
    expect(spies.onremove).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it — it fails**

Run: `npx vitest run src/lib/stash/StashCard.svelte.test.ts`
Expected: FAIL — `StashCard.svelte` missing.

- [ ] **Step 4: Implement**

`src/lib/stash/StashCard.svelte`:

```svelte
<script lang="ts">
  /**
   * One entry in the stash drawer (stash stage 04; spec «Карточка», mockup
   * `stCardHTML`): kind icon, title, «открыта в #N», the bright «отложено …»
   * line, a file's repo/branch and path, a preview, tag chips (the repo chip
   * dashed). The drawer owns pointer gestures on the card body
   * (`data-stash-id`); the card owns its buttons and the tag input, whose keys
   * are its own (`TabDrawer` skips `.tag-edit` targets). Everything shown is
   * data — no `{@html}` over user text.
   */
  import { tick } from 'svelte';
  import { t } from '../i18n';
  import { highlight, hitSnippet, indexText, type Match } from '../tabs/drawer-filter';
  import { previewLines, type InlineSeg } from '../tabs/drawer-preview';
  import StashIcon from './StashIcon.svelte';
  import { normalizeTag, TAG_MAX } from './stash-query';
  import { dropFirstLine, formatWhen, repoRelativePath, whenOf } from './stash-view';
  import type { StashEntry, TabHolder, TagChange } from './types';

  let {
    entry,
    title,
    match,
    query,
    holder,
    kb,
    expanded,
    dragging,
    compact,
    pulse,
    newTags,
    now,
    onremove,
    onfilter,
    onsettag,
    ondone,
    onhoverstart,
    onhoverend,
  }: {
    entry: StashEntry;
    title: string;
    match: Match;
    /** The query's text part: what to highlight. */
    query: string;
    /** The other window holding it, or `null`. */
    holder: TabHolder | null;
    kb: boolean;
    expanded: boolean;
    dragging: boolean;
    compact: boolean;
    pulse: boolean;
    newTags: readonly string[];
    /** For «отложено …»; ticks while the drawer is open. */
    now: number;
    onremove: () => void;
    onfilter: (tag: string) => void;
    onsettag: (change: TagChange) => void;
    /** The tag input closed: the drawer takes focus back. */
    ondone: () => void;
    onhoverstart: () => void;
    onhoverend: () => void;
  } = $props();

  let adding = $state(false);
  let draft = $state('');
  let inputEl: HTMLInputElement | undefined = $state();

  const isNote = $derived(entry.kind === 'note');
  const nameSegments = $derived(highlight(title, match.rank < 2 ? query : ''));
  const hit = $derived(match.rank === 2 ? highlight(hitSnippet(match.line, query), query) : null);
  const source = $derived(isNote ? dropFirstLine(entry.preview) : entry.preview);
  const preview = $derived(previewLines(source));
  const firstLine = $derived(indexText(source).lines[0] ?? '');
  const away = $derived(
    entry.stashedAt === null ? null : t('stash.card.away', { when: formatWhen(whenOf(entry.stashedAt, now)) })
  );
  const noteMeta = $derived(t('stash.card.note_meta', { when: formatWhen(whenOf(entry.modifiedAt, now)) }));
  const hasTags = $derived(entry.repo !== null || entry.tags.length > 0 || adding);

  async function startAdding(): Promise<void> {
    adding = true;
    draft = '';
    await tick();
    inputEl?.focus();
  }

  function finish(commit: boolean): void {
    if (!adding) return;
    const tag = commit ? normalizeTag(draft) : null;
    adding = false;
    draft = '';
    if (tag && !entry.tags.includes(tag)) onsettag({ add: [tag] });
    ondone();
  }

  function onTagKey(e: KeyboardEvent): void {
    // Its keys are its own: not the drawer's search, not the editor's.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  }
</script>

{#snippet segments(list: InlineSeg[])}
  {#each list as s, i (i)}{#if s.code}<code>{s.text}</code>{:else if s.bold}<strong>{s.text}</strong>{:else if s.italic}<em>{s.text}</em>{:else}{s.text}{/if}{/each}
{/snippet}

<div
  class="card"
  class:note={isNote}
  class:file={!isNote}
  class:kb
  class:expanded
  class:dragging
  class:pulse
  role="option"
  id="stash-card-{entry.id}"
  data-stash-id={entry.id}
  aria-selected={kb}
  tabindex={kb ? 0 : -1}
  onpointerenter={onhoverstart}
  onpointerleave={onhoverend}
>
  <div class="card-head">
    <span class="kind-ico" title={t(isNote ? 'stash.card.kind_note' : 'stash.card.kind_file')}
      ><StashIcon name={isNote ? 'note' : 'fref'} stroke={1.4} /></span
    >
    <span class="card-name"
      >{#each nameSegments as s, i (i)}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}</span
    >
    {#if holder}
      <span class="open-mark" title={t('stash.card.open_in_title')}
        >{t(isNote ? 'stash.card.open_in_note' : 'stash.card.open_in_file', { n: holder.number ?? '?' })}</span
      >
    {/if}
    {#if !adding}
      <button
        class="tag-add"
        type="button"
        tabindex="-1"
        title={t('stash.card.tag_add_title')}
        onclick={(e) => {
          e.stopPropagation();
          void startAdding();
        }}>{t('stash.card.tag_add')}</button
      >
    {/if}
    {#if !isNote}
      <button
        class="card-rm"
        type="button"
        tabindex="-1"
        title={t('stash.card.remove_file_title')}
        onclick={(e) => {
          e.stopPropagation();
          onremove();
        }}>{t('stash.card.remove_file')}</button
      >
    {/if}
  </div>
  <div class="card-meta">
    {#if away}<span class="aw">{away}</span>{/if}
    {#if isNote}<span>{noteMeta}</span>{:else}{#if entry.repo}<span>{entry.repo}</span>{/if}{#if entry.branch}<span
          class="br">⎇ {entry.branch}</span
        >{/if}{/if}
  </div>
  {#if !isNote}<div class="card-path" title={entry.path}>{repoRelativePath(entry.path, entry.repo)}</div>{/if}
  {#if hit}
    <div class="card-preview">
      <div class="hit-l">{t('tabs.drawer.in_text')}</div>
      <div class="hit">{#each hit as s, i (i)}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}</div>
    </div>
  {:else if compact}
    {#if firstLine}<div class="card-preview"><div>{firstLine}</div></div>{/if}
  {:else if preview.length > 0}
    <div class="card-preview">
      {#each preview as line, i (i)}
        <div>
          {#if line.kind === 'heading'}<b>{#each line.segs as s, j (j)}{s.text}{/each}</b>
          {:else if line.kind === 'quote'}<em>{@render segments(line.segs)}</em>
          {:else}{line.kind === 'task' ? (line.done ? '☑ ' : '☐ ') : line.kind === 'bullet' ? '• ' : ''}{@render segments(
              line.segs
            )}
          {/if}
        </div>
      {/each}
    </div>
  {/if}
  {#if hasTags}
    <div class="card-tags">
      {#if entry.repo}
        <button
          class="tag repo"
          type="button"
          tabindex="-1"
          title={t('stash.card.repo_tag_title')}
          onclick={(e) => {
            e.stopPropagation();
            if (entry.repo) onfilter(entry.repo);
          }}><StashIcon name="repo" stroke={1.4} />{entry.repo}</button
        >
      {/if}
      {#each entry.tags as tag (tag)}
        <span class="tag" class:new={newTags.includes(tag)}>
          <button
            class="tag-b"
            type="button"
            tabindex="-1"
            title={t('stash.card.tag_title', { tag })}
            onclick={(e) => {
              e.stopPropagation();
              onfilter(tag);
            }}>#{tag}</button
          ><button
            class="tag-x"
            type="button"
            tabindex="-1"
            aria-label={t('stash.card.tag_remove', { tag })}
            title={t('stash.card.tag_remove', { tag })}
            onclick={(e) => {
              e.stopPropagation();
              onsettag({ remove: [tag] });
            }}>×</button
          >
        </span>
      {/each}
      {#if adding}
        <input
          class="tag-edit"
          type="text"
          bind:this={inputEl}
          bind:value={draft}
          placeholder={t('stash.card.tag_placeholder')}
          maxlength={TAG_MAX}
          spellcheck="false"
          onkeydown={onTagKey}
          onblur={() => finish(false)}
        />
      {/if}
    </div>
  {/if}
</div>

<style>
  /* The tabs drawer's card (TabCard.svelte, mockup `.card`), plus the stash's own parts. */
  .card {
    position: relative;
    padding: 11px 12px 11px 16px;
    border-radius: 11px;
    background: var(--bg-base);
    border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
    cursor: default;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
    outline: none;
    transition:
      transform 0.3s var(--tabs-ease),
      opacity 0.22s ease,
      background-color 0.16s ease,
      border-color 0.16s ease,
      box-shadow 0.25s ease;
  }

  .card:hover {
    border-color: var(--border);
  }

  .card::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 12px;
    bottom: 12px;
    width: 3px;
    border-radius: 3px;
    background: var(--color-stash);
    opacity: 0;
    transform: scaleY(0.4);
    transition:
      opacity 0.2s,
      transform 0.25s var(--tabs-ease);
  }

  .card.kb {
    outline: 2px solid color-mix(in oklab, var(--text-muted) 70%, transparent);
    outline-offset: 1px;
  }

  .card.expanded {
    transform: translateX(-5px);
    box-shadow:
      0 2px 4px rgba(var(--tabs-shadow-rgb), 0.06),
      0 14px 32px rgba(var(--tabs-shadow-rgb), calc(var(--tabs-shadow-a) * 1.2));
    z-index: 2;
  }

  .card.dragging {
    opacity: 0.35;
  }

  /* Dedup: the card jumps to the top and pulses (mockup `stPulse`; no transform — flip owns it). */
  .card.pulse {
    animation: stPulse 1.1s ease 0.26s;
  }

  .card-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 20px;
  }

  .kind-ico {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    display: grid;
    place-items: center;
    font-size: 16px;
    color: var(--color-stash);
  }

  .card.file .kind-ico {
    color: var(--text-subtle);
  }

  .card-name {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 600;
    letter-spacing: -0.008em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .open-mark {
    flex: 0 0 auto;
    font-size: 10.5px;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .open-mark::before {
    content: '';
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--tabs-brand-a);
    margin-right: 4px;
    vertical-align: 1px;
  }

  .card-rm,
  .tag-add {
    flex: 0 0 auto;
    border: 0;
    background: transparent;
    font: inherit;
    font-size: 11px;
    color: var(--text-muted);
    padding: 2px 6px;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
    opacity: 0;
    transition:
      opacity 0.12s,
      background-color 0.12s,
      color 0.12s;
  }

  .card:hover .card-rm,
  .card.kb .card-rm,
  .card:hover .tag-add,
  .card.kb .tag-add {
    opacity: 1;
  }

  .card-rm:hover,
  .tag-add:hover {
    background: var(--highlight);
    color: var(--text-primary);
  }

  .card-meta {
    margin-top: 2px;
    font-size: 11.5px;
    color: var(--text-muted);
    display: flex;
    gap: 6px;
    white-space: nowrap;
    overflow: hidden;
  }

  .card-meta .aw {
    color: color-mix(in oklab, var(--color-stash) 85%, var(--text-primary));
    font-weight: 600;
  }

  .br {
    font-family: var(--font-code);
    font-size: 10.5px;
  }

  .card-path {
    margin-top: 1px;
    font-family: var(--font-code);
    font-size: 10.5px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .card-preview {
    margin-top: 7px;
    font-family: var(--font-text);
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--text-subtle);
    max-height: calc(1.55em * 3);
    overflow: hidden;
    -webkit-mask-image: linear-gradient(#000 calc(100% - 1.3em), transparent);
    mask-image: linear-gradient(#000 calc(100% - 1.3em), transparent);
    transition: max-height 0.38s var(--tabs-ease);
  }

  .card.expanded .card-preview {
    max-height: calc(1.55em * 10);
  }

  .card-preview > div {
    overflow-wrap: anywhere;
  }

  .card-preview b {
    color: var(--text-primary);
    font-weight: 700;
  }

  .card-preview code {
    font-family: var(--font-code);
    font-size: 0.9em;
  }

  .card-preview .hit {
    color: var(--text-primary);
  }

  .card-preview .hit-l {
    font-family: var(--tabs-ui);
    font-size: 10.5px;
    color: var(--text-muted);
    margin-bottom: 1px;
  }

  mark {
    background: color-mix(in oklab, var(--color-stash) 24%, transparent);
    color: inherit;
    border-radius: 3px;
    padding: 0 1px;
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--color-stash) 30%, transparent);
  }

  .card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
  }

  .tag {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0 7px;
    border-radius: 999px;
    font: inherit;
    font-size: 10.5px;
    line-height: 1.6;
    color: color-mix(in oklab, var(--color-stash) 70%, var(--text-primary));
    background: var(--stash-soft);
    border: 1px solid transparent;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color 0.12s;
  }

  .tag:hover {
    border-color: color-mix(in oklab, var(--color-stash) 50%, transparent);
  }

  .tag.repo {
    background: transparent;
    border: 1px dashed color-mix(in oklab, var(--color-stash) 45%, transparent);
  }

  .tag :global(svg) {
    width: 11px;
    height: 11px;
    color: var(--color-stash);
  }

  .tag.new {
    animation: tagIn 0.9s var(--tabs-ease);
  }

  .tag-b,
  .tag-x {
    border: 0;
    padding: 0;
    background: transparent;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }

  /* The × grows in on hover, like the drawer's selection dot — no layout jump at rest. */
  .tag-x {
    width: 0;
    margin-right: -3px;
    opacity: 0;
    overflow: hidden;
    color: var(--text-muted);
    transition:
      width 0.15s var(--tabs-ease),
      margin 0.15s var(--tabs-ease),
      opacity 0.15s;
  }

  .tag:hover .tag-x {
    width: 9px;
    margin-right: 0;
    opacity: 1;
  }

  .tag-x:hover {
    color: var(--text-primary);
  }

  .tag-edit {
    width: 96px;
    padding: 0 7px;
    border: 1px solid var(--color-stash);
    border-radius: 999px;
    background: var(--bg-base);
    font: inherit;
    font-size: 10.5px;
    line-height: 1.6;
    color: var(--text-primary);
    outline: none;
    box-shadow: 0 0 0 3px var(--stash-soft);
  }

  /* Compact (View → Tabs → Compact, or both drawers squeezed): one line, but the
     «отложено …» line stays — every stash card shows when it was put away (mockup). */
  :global(.compact) .card {
    padding: 7px 10px 7px 16px;
    border-radius: 9px;
  }

  :global(.compact) .card::before {
    top: 8px;
    bottom: 8px;
  }

  :global(.compact) .card-name {
    flex: 0 1 auto;
    max-width: 68%;
    font-size: 13px;
  }

  :global(.compact) .card-meta > :not(.aw) {
    display: none;
  }

  :global(.compact) .card-path {
    display: none;
  }

  :global(.compact) .card-preview,
  :global(.compact) .card.expanded .card-preview {
    margin-top: 1px;
    max-height: 1.55em;
    -webkit-mask-image: none;
    mask-image: none;
  }

  :global(.compact) .card-preview > div {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :global(.compact) .card-preview .hit-l {
    display: none;
  }

  :global(.compact) .card.expanded {
    transform: none;
  }

  :global(.compact) .card-tags {
    margin-top: 4px;
  }

  @keyframes stPulse {
    0%,
    60% {
      border-color: var(--color-stash);
      box-shadow: 0 0 0 4px color-mix(in oklab, var(--color-stash) 22%, transparent);
      background: color-mix(in oklab, var(--color-stash) 9%, var(--bg-base));
    }
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
  }

  @keyframes tagIn {
    0% {
      transform: scale(0.6);
      opacity: 0;
    }
    50% {
      transform: scale(1.15);
      box-shadow: 0 0 0 3px var(--stash-soft);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .card.pulse,
    .tag.new {
      animation: none;
    }
    .card,
    .card-preview,
    .tag-x {
      transition-duration: 0.01s !important;
    }
  }
</style>
```

- [ ] **Step 5: Run the test — it passes**

Run: `npx vitest run src/lib/stash/StashCard.svelte.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/stash/icons.ts src/lib/stash/StashIcon.svelte src/lib/stash/StashCard.svelte src/lib/stash/StashCard.svelte.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): stash card — kind icon, «отложено», open-elsewhere mark, tags, remove ref

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/stash/icons.ts src/lib/stash/StashIcon.svelte src/lib/stash/StashCard.svelte src/lib/stash/StashCard.svelte.test.ts
```

---

## Task 16: The stash bar at the bottom of the tabs drawer

**Files:**
- Create: `src/lib/stash/StashBar.svelte`, `src/lib/stash/StashBar.svelte.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/stash/StashBar.svelte.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { installCatalog } from '../i18n';
import StashBar from './StashBar.svelte';

let target: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function render(props: { dropCount?: number | null; open?: boolean; hot?: boolean } = {}) {
  const onclick = vi.fn();
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(StashBar, {
    target,
    props: {
      counts: { total: 19, stashedToday: 6, deleted: 3 },
      open: props.open ?? false,
      dropCount: props.dropCount ?? null,
      hot: props.hot ?? false,
      got: false,
      onclick,
    },
  });
  flushSync();
  return { bar: target.querySelector<HTMLElement>('.stash-bar')!, onclick };
}

beforeEach(() => installCatalog('ru'));
afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
  installCatalog('en');
});

describe('StashBar', () => {
  it('idle: the button and «· 19 · отложено сегодня 6»', () => {
    const { bar } = render();
    expect(bar.querySelector('.stash-btn')?.textContent?.trim()).toBe('Тайник');
    expect(bar.querySelector('.stash-btn')?.getAttribute('aria-pressed')).toBe('false');
    expect(bar.querySelector('.stash-sum')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('· 19 · отложено сегодня 6');
    expect(bar.classList.contains('dropmode')).toBe(false);
  });

  it('while tabs are dragged: the drop zone, with the count for more than one', () => {
    const one = render({ dropCount: 1 }).bar;
    expect(one.classList.contains('dropmode')).toBe(true);
    expect(one.querySelector('.drop .dn')).toBeNull();
    unmount(component!);
    component = null;
    target.remove();
    const three = render({ dropCount: 3, hot: true }).bar;
    expect(three.querySelector('.drop')?.textContent).toContain('Отложить в тайник');
    expect(three.querySelector('.drop .dn')?.textContent).toBe(' · 3 вкладки');
    expect(three.classList.contains('hot')).toBe(true);
  });

  it('the button toggles the stash', () => {
    const { bar, onclick } = render({ open: true });
    expect(bar.querySelector('.stash-btn')?.getAttribute('aria-pressed')).toBe('true');
    bar.querySelector<HTMLButtonElement>('.stash-btn')!.click();
    expect(onclick).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it — it fails**

Run: `npx vitest run src/lib/stash/StashBar.svelte.test.ts`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement**

`src/lib/stash/StashBar.svelte`:

```svelte
<script lang="ts">
  /**
   * The bottom area of the tabs drawer (stash stage 04; spec «Нижняя область»,
   * mockup `.stash-bar`): at rest the «Тайник» button and «N · отложено сегодня
   * M»; while tab cards are dragged, the drop zone «Отложить в тайник · N
   * вкладок». The drawer hit-tests it (`el`) and decides the drop; this only
   * draws. The count jumps when it changes (mockup `bump`).
   */
  import { untrack } from 'svelte';
  import { plural, t } from '../i18n';
  import StashIcon from './StashIcon.svelte';
  import type { StashCounts } from './types';

  let {
    counts,
    open,
    dropCount,
    hot,
    got,
    onclick,
    el = $bindable(),
  }: {
    counts: StashCounts;
    /** The stash drawer is open: the button is pressed. */
    open: boolean;
    /** Tab cards being dragged (the zone shows), or `null`. */
    dropCount: number | null;
    /** The dragged cards are over the zone. */
    hot: boolean;
    /** A put-away just landed: a short pulse (mockup `stGot`). */
    got: boolean;
    onclick: () => void;
    el?: HTMLElement;
  } = $props();

  let bump = $state(false);
  let last: number | null = null;
  let bumpTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const n = counts.total;
    untrack(() => {
      if (last !== null && n !== last) {
        bump = false;
        requestAnimationFrame(() => {
          bump = true;
          clearTimeout(bumpTimer);
          bumpTimer = setTimeout(() => {
            bump = false;
          }, 520);
        });
      }
      last = n;
    });
  });

  $effect(() => () => clearTimeout(bumpTimer));
</script>

<div class="stash-bar" class:dropmode={dropCount !== null} class:hot class:got bind:this={el}>
  <div class="idle">
    <button class="stash-btn" type="button" aria-pressed={open} title={t('stash.bar.button_title')} {onclick}
      ><StashIcon name="tray" />{t('stash.bar.button')}</button
    >
    <span class="stash-sum"
      >· <span class="num" class:bump>{counts.total}</span> · {t('stash.bar.today', { n: counts.stashedToday })}</span
    >
    <kbd title={t('stash.bar.key_title')}>→</kbd>
  </div>
  <div class="drop" aria-hidden="true">
    <StashIcon name="tray" />{t('stash.bar.drop')}{#if dropCount !== null && dropCount > 1}<span class="dn"
        >{' · '}{plural(dropCount, 'tabs.drawer.count')}</span
      >{/if}<span class="dk">⌃T</span>
  </div>
</div>

<style>
  .stash-bar {
    flex: 0 0 auto;
    position: relative;
    display: flex;
    align-items: center;
    margin: 0 12px 10px;
    padding: 0 8px 0 6px;
    height: 38px;
    border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
    border-radius: 10px;
    background: var(--bg-base);
    font-size: 11.5px;
    color: var(--text-muted);
    transition:
      height 0.22s var(--tabs-ease),
      border-color 0.18s,
      background-color 0.18s,
      margin 0.22s var(--tabs-ease);
  }

  .idle {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
    transition: opacity 0.15s;
  }

  .stash-btn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--stash-line);
    background: var(--stash-tint);
    color: var(--text-primary);
    border-radius: 7px;
    padding: 3px 9px 3px 7px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition:
      background-color 0.15s,
      border-color 0.15s;
  }

  .stash-btn :global(svg) {
    width: 14px;
    height: 14px;
    color: var(--color-stash);
  }

  .stash-btn:hover {
    border-color: color-mix(in oklab, var(--color-stash) 60%, transparent);
  }

  .stash-btn[aria-pressed='true'] {
    background: color-mix(in oklab, var(--color-stash) 18%, var(--bg-base));
    border-color: var(--color-stash);
  }

  .stash-sum {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .num {
    display: inline-block;
    color: var(--text-subtle);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .num.bump {
    animation: bump 0.5s var(--tabs-ease);
  }

  kbd {
    font-family: var(--tabs-ui);
    font-size: 10.5px;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .drop {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    opacity: 0;
    pointer-events: none;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-primary);
    transition: opacity 0.15s;
  }

  .drop :global(svg) {
    width: 16px;
    height: 16px;
    color: var(--color-stash);
  }

  .drop .dn {
    font-weight: 400;
    color: var(--text-muted);
  }

  .drop .dk {
    font-weight: 400;
    font-size: 10.5px;
    color: var(--text-muted);
    margin-left: 4px;
  }

  .stash-bar.dropmode {
    height: 58px;
    border: 1.5px dashed color-mix(in oklab, var(--color-stash) 60%, transparent);
    background: color-mix(in oklab, var(--color-stash) 6%, var(--bg-base));
  }

  .dropmode .idle {
    opacity: 0;
    pointer-events: none;
  }

  .dropmode .drop {
    opacity: 1;
  }

  .stash-bar.hot {
    border-style: solid;
    border-color: var(--color-stash);
    background: color-mix(in oklab, var(--color-stash) 16%, var(--bg-base));
    box-shadow: 0 0 0 3px var(--stash-soft);
  }

  .stash-bar.got {
    animation: stGot 0.7s var(--tabs-ease);
  }

  @keyframes bump {
    40% {
      transform: scale(1.5);
      color: var(--text-primary);
    }
  }

  @keyframes stGot {
    30% {
      border-color: var(--color-stash);
      box-shadow: 0 0 0 4px var(--stash-soft);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .num.bump,
    .stash-bar.got {
      animation: none;
    }
    .stash-bar {
      transition-duration: 0.01s;
    }
  }
</style>
```

- [ ] **Step 4: Run the test — it passes**

Run: `npx vitest run src/lib/stash/StashBar.svelte.test.ts`
Expected: PASS (3 tests). (`tabs.drawer.count.few` is «{count} вкладки» — reused, not duplicated.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/stash/StashBar.svelte src/lib/stash/StashBar.svelte.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): stash bar — button, counts and the put-away drop zone

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/stash/StashBar.svelte src/lib/stash/StashBar.svelte.test.ts
```

---

## Task 17: The stash drawer

**Files:**
- Create: `src/lib/stash/StashDrawer.svelte`, `src/lib/stash/StashDrawer.svelte.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/stash/StashDrawer.svelte.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { installCatalog } from '../i18n';
import StashDrawer, { type StashDrawerHandle } from './StashDrawer.svelte';
import { createStashStore, type StashStore } from './stash-store.svelte';
import type { StashEntry, TabHolder } from './types';

const NOW = Date.now();
const MIN = 60_000;

function entry(id: string, over: Partial<StashEntry> = {}): StashEntry {
  return {
    id,
    kind: 'note',
    path: `/n/${id}.md`,
    title: `Title ${id}`,
    repo: null,
    branch: null,
    tags: [],
    createdAt: 0,
    modifiedAt: NOW - 100 * MIN,
    stashedAt: null,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: '',
    ...over,
  };
}

const ENTRIES = [
  entry('a', { modifiedAt: NOW - 5 * MIN, repo: 'shelf' }),
  entry('b', { modifiedAt: NOW - 50 * MIN, repo: 'shelf', kind: 'file', title: 'b.md', openedAt: NOW - MIN }),
  entry('c', { modifiedAt: NOW - 500 * MIN, repo: 'infra', tags: ['ops'] }),
  entry('d', { modifiedAt: NOW - 1 * MIN, repo: 'shelf' }),
];

interface H {
  store: StashStore;
  root: HTMLElement;
  handle: () => StashDrawerHandle;
  onopen: ReturnType<typeof vi.fn>;
  destroy: () => void;
}

let h: H;

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function () {};
  Element.prototype.scrollTo ??= function () {} as Element['scrollTo'];
  Element.prototype.animate ??= function () {
    return { cancel() {}, finished: Promise.resolve(), onfinish: null } as unknown as Animation;
  };
  Element.prototype.getAnimations ??= () => [];
  globalThis.CSS ??= {} as typeof CSS;
  CSS.escape ??= (s: string) => s;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    flushSync();
    await tick();
    await Promise.resolve();
  }
}

async function setup(opts: { repo?: string | null; openHere?: string[]; holders?: (TabHolder | null)[] } = {}): Promise<H> {
  const store = createStashStore({
    list: async () => ENTRIES,
    counts: async () => ({ total: ENTRIES.length, stashedToday: 0, deleted: 0 }),
    holders: async (paths) => opts.holders ?? paths.map(() => null),
    windowRepo: async () => opts.repo ?? null,
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = $state<{ handle: StashDrawerHandle | undefined }>({ handle: undefined });
  const onopen = vi.fn();
  const component = mount(StashDrawer, {
    target,
    props: {
      stash: store,
      openHere: new Set(opts.openHere ?? []),
      width: 400,
      narrow: false,
      compact: false,
      windowNumber: 22,
      dropReady: false,
      dropHot: false,
      draggingId: null,
      onpress: vi.fn(),
      onopen,
      onremove: vi.fn(),
      onsettag: vi.fn(),
      onfocusrequest: vi.fn(),
      get handle() {
        return props.handle;
      },
      set handle(v: StashDrawerHandle | undefined) {
        props.handle = v;
      },
    },
  });
  store.open();
  await settle();
  return {
    store,
    root: target,
    handle: () => {
      if (!props.handle) throw new Error('no handle');
      return props.handle;
    },
    onopen,
    destroy: () => {
      unmount(component);
      target.remove();
    },
  };
}

const ids = () => [...h.root.querySelectorAll<HTMLElement>('[data-stash-id]')].map((el) => el.dataset.stashId);
const key = (k: string, init: KeyboardEventInit = {}) =>
  h.handle().key(new KeyboardEvent('keydown', { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, ...init }));

beforeEach(() => installCatalog('ru'));
afterEach(() => {
  h?.destroy();
  installCatalog('en');
});

describe('StashDrawer', () => {
  it('lists the stash minus what is open here, newest change first; the title counts everything', async () => {
    h = await setup({ openHere: ['/n/a.md'] });
    expect(ids()).toEqual(['d', 'b', 'c']);
    expect(h.root.querySelector('.drawer-title .cnt')?.textContent).toContain('4');
    expect(h.root.querySelector('.f-note')?.textContent).toBe('весь тайник · 3 из 4 · 1 во вкладках');
  });

  it('opens filtered by the window repo; × shows everything, + puts it back', async () => {
    h = await setup({ repo: 'shelf' });
    expect(ids()).toEqual(['d', 'a', 'b']);
    expect(h.root.querySelector('.fchip')?.textContent).toContain('shelf');
    h.root.querySelector<HTMLButtonElement>('.fchip-x')!.click();
    await settle();
    expect(ids()).toEqual(['d', 'a', 'b', 'c']);
    h.root.querySelector<HTMLButtonElement>('.f-add')!.click();
    await settle();
    expect(ids()).toEqual(['d', 'a', 'b']);
  });

  it('keys filter it: letters, Backspace, then ⌫ on an empty query drops the chip', async () => {
    h = await setup({ repo: 'shelf' });
    expect(key('b')).toBe(true);
    await settle();
    expect(h.root.querySelector('.s-q')?.textContent).toBe('b');
    expect(ids()).toEqual(['b']);
    key('Backspace');
    key('Backspace');
    await settle();
    expect(h.store.state.repoChip).toBeNull();
  });

  it('Enter opens the top result', async () => {
    h = await setup();
    key('T');
    key('i');
    await settle();
    expect(key('Enter')).toBe(true);
    expect(h.onopen).toHaveBeenCalledWith(expect.objectContaining({ id: 'd' }));
  });

  it('a sort button re-sorts and says which is on', async () => {
    h = await setup();
    const kind = h.root.querySelector<HTMLButtonElement>('[data-ssort="kind"]')!;
    kind.click();
    await settle();
    expect(kind.getAttribute('aria-pressed')).toBe('true');
    expect(ids()).toEqual(['d', 'a', 'c', 'b']);
    // ⌘ and Ctrl together: jsdom's empty `navigator.platform` makes `isMacPlatform()` false.
    expect(key('r', { metaKey: true, ctrlKey: true })).toBe(true);
    await settle();
    expect(ids()[0]).toBe('b');
  });

  it('an entry held by another window says where', async () => {
    h = await setup({ holders: [null, null, { label: 'editor-19', number: 19 }, null] });
    expect(h.root.querySelector('[data-stash-id="c"] .open-mark')?.textContent).toBe('открыта в #19');
  });

  it('empty: says why', async () => {
    h = await setup({ openHere: ENTRIES.map((e) => e.path) });
    expect(h.root.querySelector('.empty')?.textContent).toBe('Всё с этим тегом уже открыто вкладками');
    key('z');
    key('z');
    await settle();
    expect(h.root.querySelector('.empty')?.textContent).toBe('Ничего не найдено');
  });
});
```

- [ ] **Step 2: Run it — it fails**

Run: `npx vitest run src/lib/stash/StashDrawer.svelte.test.ts`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement**

`src/lib/stash/StashDrawer.svelte`:

```svelte
<script lang="ts" module>
  export interface StashDrawerHandle {
    /** A key the tabs drawer routed here while the stash has the keys. `true`: used. */
    key(e: KeyboardEvent): boolean;
    /** DOM focus into the list, unless something in the drawer has it already. */
    focus(): void;
    /** The point is over the open stash drawer — a drop target. */
    contains(x: number, y: number): boolean;
    /** Its left edge, px; `null` while closed. */
    left(): number | null;
  }
</script>

<script lang="ts">
  /**
   * The stash drawer (stash stage 04; spec «Дровер тайника», mockup
   * `stash-drawers.html`): the tabs drawer's mirror on the right edge, in the
   * stash colour. Rendered inside `TabDrawer`'s `display: contents` root, so
   * the tabs drawer's focus trap, capture-phase key handler and drag machine
   * cover it: this component never listens on `window`. It answers the keys
   * the tabs drawer routes to it (`handle.key`) and reports presses on cards
   * (`onpress`) — the tabs drawer decides click vs drag.
   */
  import { tick } from 'svelte';
  import { flip } from 'svelte/animate';
  import { cubicOut } from 'svelte/easing';
  import type { TransitionConfig } from 'svelte/transition';
  import { t } from '../i18n';
  import { acceleratorAriaKeyShortcuts, acceleratorLabel, isMacPlatform } from '../editor/hotkey-label';
  import { EXPAND_MS } from '../tabs/drawer-state';
  import StashCard from './StashCard.svelte';
  import StashIcon from './StashIcon.svelte';
  import type { StashStore } from './stash-store.svelte';
  import {
    STASH_SORT_KEYS,
    backspaceStash,
    escapeStash,
    focusDrawer,
    moveStashKb,
    setRepoChip,
    setStashQuery,
    setStashSort,
    stashKbTarget,
    stashKeyAction,
  } from './stash-state';
  import { entryTitle, stashView, type StashSort } from './stash-view';
  import type { StashEntry, TagChange } from './types';

  let {
    stash,
    openHere,
    width,
    narrow,
    compact,
    windowNumber,
    dropReady,
    dropHot,
    draggingId,
    onpress,
    onopen,
    onremove,
    onsettag,
    onfocusrequest,
    handle = $bindable(),
  }: {
    stash: StashStore;
    /** Paths open as tabs in this window: not shown here (D10). */
    openHere: ReadonlySet<string>;
    width: number;
    narrow: boolean;
    compact: boolean;
    windowNumber: number | null;
    /** Tab cards are being dragged: the drawer shows it can take them. */
    dropReady: boolean;
    /** …and they are over it now. */
    dropHot: boolean;
    /** The stash card being dragged (the tabs drawer runs the drag). */
    draggingId: string | null;
    onpress: (entry: StashEntry, card: HTMLElement, e: PointerEvent) => void;
    /** Enter: open here and close both drawers. */
    onopen: (entry: StashEntry) => void;
    onremove: (entry: StashEntry) => void;
    onsettag: (entry: StashEntry, change: TagChange) => void;
    /** A press inside: the stash takes the keys. */
    onfocusrequest: () => void;
    handle?: StashDrawerHandle;
  } = $props();

  const mac = isMacPlatform();
  const untitled = t('stash.untitled');

  let wrapEl: HTMLDivElement | undefined = $state();
  let asideEl: HTMLElement | undefined = $state();
  let listEl: HTMLDivElement | undefined = $state();
  let expandedId = $state<string | null>(null);
  let flashing = $state<StashSort | null>(null);
  let now = $state(Date.now());
  let expandTimer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const open = $derived(stash.state.open);
  const focused = $derived(open && stash.state.focus === 'stash');
  const view = $derived(
    stashView({
      entries: stash.entries,
      indexes: stash.indexes,
      openHere,
      repoChip: stash.state.repoChip,
      query: stash.state.query,
      sort: stash.state.sort,
      untitled,
    })
  );
  const visible = $derived(view.rows.map((r) => r.entry.id));
  const kbId = $derived(focused ? stashKbTarget(stash.state, visible) : null);
  const searchNote = $derived(
    stash.state.query
      ? [
          visible.length > 0 ? t('tabs.drawer.search_count', { shown: visible.length, total: view.total }) : '',
          t('tabs.drawer.search_reset'),
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
  );
  const filterNote = $derived.by(() => {
    const counts = { shown: view.rows.length, total: view.total };
    const base =
      stash.state.repoChip !== null ? t('stash.filter.note_repo', counts) : t('stash.filter.note_all', counts);
    return view.openHere > 0 ? `${base} ${t('stash.filter.in_tabs', { n: view.openHere })}` : base;
  });
  const emptyText = $derived.by(() => {
    if (!stash.loaded || view.rows.length > 0) return null;
    if (stash.state.query) return t('tabs.drawer.empty');
    if (view.openHere > 0) return t('stash.drawer.empty_open_here');
    if (stash.state.repoChip !== null) return t('stash.drawer.empty_repo', { repo: stash.state.repoChip });
    return t('stash.drawer.empty_all');
  });

  $effect(() => {
    handle = { key, focus: focusList, contains, left };
  });

  // What is on screen: only a card the human can see pulses after a reload.
  $effect(() => {
    stash.setShown(visible);
  });

  $effect(() => {
    if (draggingId !== null) {
      clearTimeout(expandTimer);
      expandedId = null;
    }
  });

  // «отложено только что» must not stay «только что» for an hour.
  $effect(() => {
    if (!open) {
      clearTimeout(expandTimer);
      expandedId = null;
      return;
    }
    now = Date.now();
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });

  $effect(() => () => {
    clearTimeout(expandTimer);
    clearTimeout(flashTimer);
  });

  function reducedMotion(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function motion(ms: number): number {
    return reducedMotion() ? 0 : ms;
  }

  // The tabs drawer's `arrive` / `collapse`, mirrored: cards come in from and leave to the right.
  function arriveR(_node: Element): TransitionConfig {
    return {
      duration: motion(500),
      easing: cubicOut,
      css: (k) => `opacity: ${k}; transform: translateX(${(1 - k) * 18}px);`,
    };
  }

  function collapseR(node: Element): TransitionConfig {
    const el = node as HTMLElement;
    const height = el.offsetHeight;
    const padding = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    return {
      duration: motion(230),
      easing: cubicOut,
      css: (k) =>
        `overflow: hidden; opacity: ${k}; height: ${k * height}px; padding-bottom: ${k * padding}px;` +
        ` transform: translateX(${(1 - k) * 30}px) scale(${0.97 + 0.03 * k});`,
    };
  }

  function cardEl(id: string): HTMLElement | null {
    return listEl?.querySelector<HTMLElement>(`[data-stash-id="${CSS.escape(id)}"]`) ?? null;
  }

  function focusList(): void {
    void tick().then(() => {
      if (stash.state.open && !asideEl?.contains(document.activeElement)) listEl?.focus({ preventScroll: true });
    });
  }

  function contains(x: number, y: number): boolean {
    if (!open || !wrapEl) return false;
    const r = wrapEl.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function left(): number | null {
    return open && asideEl ? asideEl.getBoundingClientRect().left : null;
  }

  function setQuery(query: string): void {
    stash.update((s) => setStashQuery(s, query));
    if (listEl) listEl.scrollTop = 0;
  }

  function sortBy(sort: StashSort): void {
    stash.update((s) => setStashSort(s, sort));
    flashing = null;
    clearTimeout(flashTimer);
    requestAnimationFrame(() => {
      flashing = sort;
      flashTimer = setTimeout(() => {
        flashing = null;
      }, 600);
    });
    listEl?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  /** A click on a tag chip: filter by it, with the keys in the stash (mockup). */
  function filterByTag(tag: string): void {
    stash.update((s) => focusDrawer(setStashQuery(s, `#${tag}`), 'stash'));
    if (listEl) listEl.scrollTop = 0;
  }

  function key(e: KeyboardEvent): boolean {
    const action = stashKeyAction(e, stash.state.query, mac);
    switch (action.kind) {
      case 'none':
        return false;
      case 'enter': {
        // Enter on a button in the drawer presses it.
        if (e.target instanceof HTMLButtonElement && asideEl?.contains(e.target)) return false;
        const id = stashKbTarget(stash.state, visible);
        const row = id === null ? undefined : view.rows.find((r) => r.entry.id === id);
        if (!row) return false;
        onopen(row.entry);
        return true;
      }
      case 'escape':
        stash.update(escapeStash);
        return true;
      case 'sort':
        sortBy(action.sort);
        return true;
      case 'type':
        setQuery(stash.state.query + action.char);
        return true;
      case 'backspace':
        stash.update(backspaceStash);
        return true;
      case 'move': {
        stash.update((s) => moveStashKb(s, action.delta, visible));
        const id = stashKbTarget(stash.state, visible);
        void tick().then(() => {
          const el = id ? cardEl(id) : null;
          el?.focus({ preventScroll: true });
          el?.scrollIntoView({ block: 'nearest' });
        });
        return true;
      }
    }
  }

  function cardEnter(id: string): void {
    clearTimeout(expandTimer);
    if (draggingId !== null) return;
    expandTimer = setTimeout(() => {
      if (draggingId === null && stash.state.open) expandedId = id;
    }, EXPAND_MS);
  }

  function cardLeave(id: string): void {
    clearTimeout(expandTimer);
    if (expandedId === id) expandedId = null;
  }

  function onListPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    if (e.target.closest('.card-rm, .tag, .tag-add, .tag-edit')) return;
    const card = e.target.closest<HTMLElement>('[data-stash-id]');
    const id = card?.dataset.stashId;
    const row = id === undefined ? undefined : view.rows.find((r) => r.entry.id === id);
    if (!card || !row) return;
    e.preventDefault();
    clearTimeout(expandTimer);
    expandedId = null;
    onpress(row.entry, card, e);
  }
</script>

{#snippet magnifier()}
  <svg class="mag" viewBox="0 0 16 16" aria-hidden="true"
    ><circle cx="6.8" cy="6.8" r="4.8" fill="none" stroke="currentColor" stroke-width="1.7" /><path
      d="M10.4 10.4 14.2 14.2"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
    /></svg
  >
{/snippet}

<div
  class="stash-wrap"
  class:open
  class:narrow
  class:compact
  style:width="{width}px"
  role="presentation"
  bind:this={wrapEl}
  onpointerdowncapture={() => onfocusrequest()}
>
  <aside
    class="drawer stash-drawer"
    class:focused
    class:drop-ready={open && dropReady && !dropHot}
    class:drop-hot={open && dropHot}
    aria-label={t('stash.drawer.title')}
    inert={!open}
    bind:this={asideEl}
  >
    <div class="drawer-head">
      <div class="drawer-title">
        <b
          ><span class="st-g"><StashIcon name="tray" /></span>{t('stash.drawer.title')}
          <span class="cnt">· {view.total}</span></b
        >
        <small class="type-hint" class:off={!!stash.state.query}>{@render magnifier()}{t('stash.drawer.type_hint')}</small>
        <small class="focus-hint">{t('stash.drawer.focus_stash')} <kbd>→</kbd></small>
      </div>
      <div class="st-filter">
        {#if stash.state.repoChip !== null}
          <span class="fchip" title={t('stash.filter.chip_title', { n: windowNumber ?? '', repo: stash.state.repoChip })}
            ><StashIcon name="repo" stroke={1.4} />{stash.state.repoChip}<button
              class="fchip-x"
              type="button"
              aria-label={t('stash.filter.remove')}
              title={t('stash.filter.remove_title')}
              onclick={() => stash.update((s) => setRepoChip(s, null))}>×</button
            ></span
          >
        {:else if stash.repo !== null}
          <button
            class="f-add"
            type="button"
            title={t('stash.filter.add_title')}
            onclick={() => stash.update((s) => setRepoChip(s, stash.repo))}
            >+ <StashIcon name="repo" stroke={1.4} />{stash.repo}</button
          >
        {/if}
        <span class="f-note">{filterNote}</span>
      </div>
      <div class="sorts">
        <span class="lbl">{t('tabs.drawer.sort_label')}</span>
        {#each STASH_SORT_KEYS as sortKey, i (sortKey.sort)}
          {#if i > 0}<span class="dot" aria-hidden="true">·</span>{/if}
          <button
            type="button"
            class="sort-btn"
            class:flash={flashing === sortKey.sort}
            aria-pressed={stash.state.sort === sortKey.sort}
            data-ssort={sortKey.sort}
            title={t(`stash.drawer.sort_${sortKey.sort}_title`)}
            aria-keyshortcuts={acceleratorAriaKeyShortcuts(sortKey.accelerator)}
            onclick={() => sortBy(sortKey.sort)}
          >
            {t(`stash.drawer.sort_${sortKey.sort}`)}
            <kbd>{acceleratorLabel(sortKey.accelerator)}</kbd>
          </button>
        {/each}
      </div>
    </div>

    <div class="search" class:on={!!stash.state.query} aria-live="polite">
      <span class="s-ico" aria-hidden="true">{@render magnifier()}</span>
      <span class="s-q">{stash.state.query}</span><span class="caret" aria-hidden="true"></span>
      <span class="s-n">{searchNote}</span>
    </div>

    <div
      class="tab-list"
      role="listbox"
      aria-label={t('stash.drawer.title')}
      aria-activedescendant={kbId === null ? undefined : `stash-card-${kbId}`}
      tabindex="-1"
      bind:this={listEl}
      onpointerdown={onListPointerDown}
      oncontextmenu={(e) => e.preventDefault()}
    >
      {#each view.rows as row (row.entry.id)}
        <div class="card-slot" animate:flip={{ duration: motion(300), easing: cubicOut }} in:arriveR out:collapseR>
          <StashCard
            entry={row.entry}
            title={entryTitle(row.entry, untitled)}
            match={row.match}
            query={view.text}
            holder={stash.holders.get(row.entry.path) ?? null}
            kb={row.entry.id === kbId}
            expanded={row.entry.id === expandedId}
            dragging={row.entry.id === draggingId}
            {compact}
            pulse={stash.pulse.has(row.entry.id)}
            newTags={stash.newTags.get(row.entry.id) ?? []}
            {now}
            onremove={() => onremove(row.entry)}
            onfilter={filterByTag}
            onsettag={(change) => onsettag(row.entry, change)}
            ondone={focusList}
            onhoverstart={() => cardEnter(row.entry.id)}
            onhoverend={() => cardLeave(row.entry.id)}
          />
        </div>
      {/each}
      {#if emptyText}<div class="empty">{emptyText}</div>{/if}
    </div>

    <div class="st-foot">
      <span
        ><b>{t('stash.foot.drag')}</b> {t('stash.foot.drag_tail')} · <b>{t('stash.foot.tag')}</b>
        {t('stash.foot.tag_tail')} · <b>{t('stash.foot.keys')}</b> {t('stash.foot.keys_tail')}</span
      >
    </div>

    <div class="drop-veil" aria-hidden="true">
      <span><StashIcon name="tray" />{t('stash.bar.drop')}</span>
    </div>
  </aside>
</div>

<style>
  /* Values from the mockup (`.stash-wrap`, `.drawer.stash-drawer`, and the tabs
     drawer's shared chrome). Scoped styles cannot be shared with TabDrawer.svelte,
     so the chrome is repeated here — keep the two in step. */
  .stash-wrap {
    position: fixed;
    top: 0;
    bottom: 0;
    right: 0;
    z-index: 910;
    pointer-events: auto;
    font-family: var(--tabs-ui);
    color: var(--text-primary);
    transform: translateX(calc(100% + 8px));
    transition:
      transform 0.34s var(--tabs-ease),
      width 0.34s var(--tabs-ease);
  }

  .stash-wrap.open {
    transform: translateX(0);
  }

  .drawer {
    --acc: var(--color-stash);
    position: absolute;
    top: 6px;
    bottom: 6px;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    background: var(--stash-tint);
    border: 1px solid var(--stash-line);
    border-right: none;
    border-radius: 14px 0 0 14px;
    box-shadow: none;
    transition: box-shadow 0.34s ease;
  }

  .open .drawer {
    box-shadow:
      -14px 0 44px rgba(var(--tabs-shadow-rgb), calc(var(--tabs-shadow-a) * 1.4)),
      -2px 0 8px rgba(var(--tabs-shadow-rgb), var(--tabs-shadow-a));
  }

  /* Focus is shown only by this rim, in the drawer's own colour; the other drawer is not dimmed. */
  .drawer::after {
    content: '';
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s;
    box-shadow:
      inset 0 0 0 1.5px color-mix(in oklab, var(--acc) 65%, transparent),
      0 0 16px 1px color-mix(in oklab, var(--acc) 30%, transparent);
  }

  .drawer.focused::after {
    opacity: 1;
  }

  .drawer-head {
    padding: 16px 18px 10px 20px;
    flex: 0 0 auto;
  }

  .drawer-title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .drawer-title b {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.005em;
    white-space: nowrap;
  }

  .drawer-title .cnt {
    font-weight: 400;
    color: var(--text-muted);
    margin-left: 2px;
  }

  .st-g {
    display: inline-block;
    width: 14px;
    height: 14px;
    font-size: 14px;
    vertical-align: -2px;
    margin-right: 6px;
    color: var(--color-stash);
  }

  .drawer-title small {
    display: block;
    font-size: 11px;
    line-height: 1.4;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .type-hint {
    transition: opacity 0.15s;
  }

  .type-hint.off {
    opacity: 0;
  }

  .drawer-title .focus-hint {
    display: none;
  }

  .focus-hint kbd {
    font-size: 11px;
    color: var(--text-subtle);
  }

  /* Without the keys, the header says how to get them back. */
  .open .drawer:not(.focused) .drawer-title .focus-hint {
    display: block;
  }

  .open .drawer:not(.focused) .type-hint {
    display: none;
  }

  .mag {
    width: 1em;
    height: 1em;
    flex: 0 0 auto;
    display: block;
  }

  .type-hint .mag {
    display: inline-block;
    vertical-align: middle;
    margin: -0.1em 5px 0 0;
  }

  .st-filter {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: -3px 0 9px;
    min-height: 22px;
  }

  .fchip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 2px 1px 8px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--color-stash) 16%, var(--bg-base));
    border: 1px solid var(--stash-line);
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
  }

  .fchip :global(svg),
  .f-add :global(svg) {
    width: 11px;
    height: 11px;
    color: var(--color-stash);
  }

  .fchip-x {
    border: 0;
    background: transparent;
    width: 18px;
    height: 18px;
    padding: 0;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font: inherit;
    font-size: 13px;
    line-height: 1;
    color: var(--text-muted);
    cursor: pointer;
  }

  .fchip-x:hover {
    background: var(--highlight);
    color: var(--text-primary);
  }

  .f-add {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px dashed var(--stash-line);
    background: transparent;
    border-radius: 999px;
    padding: 2px 9px;
    font: inherit;
    font-size: 11.5px;
    color: var(--text-subtle);
    cursor: pointer;
    white-space: nowrap;
  }

  .f-add:hover {
    border-color: var(--color-stash);
    color: var(--text-primary);
  }

  .f-note {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sorts {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 0;
    white-space: nowrap;
  }

  .sorts .lbl {
    font-size: 11px;
    color: var(--text-muted);
    margin-right: 2px;
  }

  .sorts .dot {
    color: var(--text-muted);
    opacity: 0.6;
    font-size: 11px;
    padding: 0 1px;
  }

  .narrow .sorts .lbl,
  .narrow .sorts kbd {
    display: none;
  }

  .sort-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid transparent;
    background: transparent;
    white-space: nowrap;
    border-radius: 7px;
    padding: 3px 6px;
    font: inherit;
    font-size: 11.5px;
    color: var(--text-subtle);
    cursor: pointer;
    transition:
      background-color 0.15s,
      border-color 0.15s,
      color 0.15s;
  }

  .sort-btn:hover {
    background: var(--bg-base);
    border-color: var(--border);
    color: var(--text-primary);
  }

  .sort-btn[aria-pressed='true'] {
    background: var(--bg-base);
    border-color: var(--stash-line);
    color: var(--text-primary);
  }

  .sort-btn.flash {
    animation: flash 0.6s ease;
  }

  kbd {
    font-family: var(--tabs-ui);
    font-size: 10.5px;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .search {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0 14px 0 12px;
    padding: 0 10px;
    height: 0;
    overflow: hidden;
    opacity: 0;
    background: var(--bg-base);
    border: 1px solid transparent;
    border-radius: 9px;
    font-size: 13px;
    transition:
      height 0.2s var(--tabs-ease),
      opacity 0.15s,
      margin 0.2s var(--tabs-ease),
      border-color 0.2s;
  }

  .search.on {
    height: 34px;
    opacity: 1;
    margin-bottom: 8px;
    border-color: var(--border);
  }

  .s-ico {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .s-q {
    white-space: pre;
    color: var(--text-primary);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .caret {
    width: 1.5px;
    height: 15px;
    margin-left: -6px;
    background: var(--color-cursor, var(--text-primary));
    animation: blink 1.1s steps(1) infinite;
  }

  .s-n {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .tab-list {
    position: relative;
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px 12px 14px 14px;
    scrollbar-width: thin;
    scrollbar-color: var(--highlight) transparent;
    outline: none;
  }

  .card-slot {
    padding-bottom: 7px;
  }

  .compact .card-slot {
    padding-bottom: 4px;
  }

  .empty {
    padding: 34px 10px;
    text-align: center;
    font-size: 12.5px;
    color: var(--text-muted);
    animation: arrive 0.3s var(--tabs-ease);
  }

  .st-foot {
    flex: 0 0 auto;
    height: 38px;
    padding: 0 18px;
    display: flex;
    align-items: center;
    font-size: 11.5px;
    color: var(--text-muted);
    border-top: 1px solid color-mix(in oklab, var(--stash-line) 60%, transparent);
    white-space: nowrap;
    overflow: hidden;
  }

  .st-foot b {
    color: var(--text-subtle);
    font-weight: 600;
  }

  /* A tab card dragged anywhere: a dashed outline says the drawer takes it; over it, the label. */
  .drop-veil {
    position: absolute;
    inset: 8px;
    border-radius: 12px;
    border: 2px dashed var(--color-stash);
    background: color-mix(in oklab, var(--color-stash) 10%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    pointer-events: none;
    transition:
      opacity 0.15s,
      background-color 0.15s;
    z-index: 8;
  }

  .drop-veil span {
    display: inline-flex;
    gap: 7px;
    align-items: center;
    padding: 8px 14px;
    border-radius: 999px;
    background: var(--bg-base);
    border: 1px solid var(--stash-line);
    box-shadow: 0 6px 20px rgba(var(--tabs-shadow-rgb), var(--tabs-shadow-a));
    font-size: 13px;
    font-weight: 600;
    transition: opacity 0.15s;
  }

  .drop-veil span :global(svg) {
    width: 16px;
    height: 16px;
    color: var(--color-stash);
  }

  .drop-ready .drop-veil {
    opacity: 1;
    background: transparent;
    border-color: color-mix(in oklab, var(--color-stash) 45%, transparent);
  }

  .drop-ready .drop-veil span {
    opacity: 0;
  }

  .drop-hot .drop-veil {
    opacity: 1;
    background: color-mix(in oklab, var(--color-stash) 10%, transparent);
    border-color: var(--color-stash);
  }

  .drop-hot .drop-veil span {
    opacity: 1;
  }

  @keyframes flash {
    0% {
      background: color-mix(in oklab, var(--color-stash) 22%, var(--bg-base));
      color: var(--text-primary);
    }
    100% {
      background: var(--bg-base);
    }
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }

  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateX(18px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .caret,
    .empty {
      animation: none;
    }
    .stash-wrap,
    .drawer::after {
      transition-duration: 0.01s !important;
    }
  }
</style>
```

- [ ] **Step 4: Run the test — it passes**

Run: `npx vitest run src/lib/stash/StashDrawer.svelte.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Type check**

Run: `npm run check`
Expected: 0 errors (warnings about an interactive element inside `role="option"` are the same shape as TabCard's close button inside `role="tab"`; if svelte-check reports them as errors, add `<!-- svelte-ignore a11y_interactive_supports_focus -->`-style ignores exactly as TabCard does, nothing broader).

- [ ] **Step 6: Commit**

```bash
git add src/lib/stash/StashDrawer.svelte src/lib/stash/StashDrawer.svelte.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): the stash drawer — list, repo chip, sorts, search line, drop veil

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/stash/StashDrawer.svelte src/lib/stash/StashDrawer.svelte.test.ts
```

---

## Task 18: `TabDrawer` hosts the stash — props, layout, render, open/close

**Files:**
- Modify: `src/lib/tabs/TabDrawer.svelte`
- Modify: `src/lib/tabs/TabDrawer.svelte.test.ts` (harness takes extra props; new describe block)

This task makes the stash appear and open/close with the tabs drawer. Keys and focus are Task 19, drags Task 20. Existing props stay required as they are; every new prop is optional, so the existing tests keep mounting the tabs drawer alone.

- [ ] **Step 1: Let the test harness pass extra props**

In `src/lib/tabs/TabDrawer.svelte.test.ts`:

1. Add to the imports:

```ts
import type { ComponentProps } from 'svelte';
import { createStashStore, type StashStore } from '../stash/stash-store.svelte';
import type { StashEntry } from '../stash/types';
```

2. Change the signature `function setup(list: TabListState = initialList()): Harness {` to:

```ts
function setup(list: TabListState = initialList(), extra: Partial<ComponentProps<typeof TabDrawer>> = {}): Harness {
```

3. In that function, replace `    props: {` (the line right after `    target,` inside `mount(TabDrawer, {`) with `    props: Object.assign({`, and replace the closing lines

```ts
      set handle(v: TabDrawerHandle | undefined) {
        props.handle = v;
      },
    },
  });
```

with

```ts
      set handle(v: TabDrawerHandle | undefined) {
        props.handle = v;
      },
    }, extra),
  });
```

(`Object.assign` onto the literal keeps its `list`/`handle` getters; the extra props are plain values.)

4. At the end of the file add the helpers and the first block:

```ts
function stashEntry(id: string, path: string, over: Partial<StashEntry> = {}): StashEntry {
  return {
    id,
    kind: 'note',
    path,
    title: id,
    repo: null,
    branch: null,
    tags: [],
    createdAt: 0,
    modifiedAt: 1,
    stashedAt: null,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: '',
    ...over,
  };
}

/** s3 is `/p/alpha.md` — open here as tab `a`, so the stash hides it. */
function fakeStash(): StashStore {
  const entries = [
    stashEntry('s1', '/n/one.md', { title: 'One note', modifiedAt: 1 }),
    stashEntry('s2', '/n/two.md', { title: 'Beta note', modifiedAt: 2 }),
    stashEntry('s3', '/p/alpha.md', { title: 'alpha.md', kind: 'file' }),
  ];
  return createStashStore({
    list: async () => entries,
    counts: async () => ({ total: entries.length, stashedToday: 1, deleted: 0 }),
    holders: async (paths) => paths.map(() => null),
    windowRepo: async () => null,
  });
}

async function settleLong(): Promise<void> {
  for (let i = 0; i < 4; i++) await settle();
}

const stashIds = () =>
  [...h.root().parentElement!.querySelectorAll<HTMLElement>('[data-stash-id]')].map((x) => x.dataset.stashId);

describe('TabDrawer — hosts the stash (stash stage 04)', () => {
  let stash: StashStore;
  const onstashopen = vi.fn();
  const onputaway = vi.fn();

  beforeEach(() => {
    h?.destroy();
    stash = fakeStash();
    onstashopen.mockClear();
    onputaway.mockClear();
    h = setup(initialList(), { stash, onstashopen, onputaway, onstashremove: vi.fn(), onstashtag: vi.fn() });
  });

  it('has the stash bar and a closed stash drawer', async () => {
    h.handle().toggle();
    await settle();
    expect(el('.stash-bar')).not.toBeNull();
    expect(h.root().parentElement!.querySelector('.stash-wrap.open')).toBeNull();
  });

  it('the bar button opens the stash; an entry open here as a tab is not in it', async () => {
    h.handle().toggle();
    await settle();
    el('.stash-btn').click();
    await settleLong();
    expect(stash.state.open).toBe(true);
    expect(h.root().parentElement!.querySelector('.stash-wrap.open')).not.toBeNull();
    expect(stashIds()).toEqual(['s2', 's1']);
  });

  it('closing the tabs drawer closes the stash too', async () => {
    h.handle().toggleStash();
    await settleLong();
    h.handle().close();
    await settle();
    expect(stash.state.open).toBe(false);
    expect(h.root().classList.contains('open')).toBe(false);
  });

  it('toggleStash from a closed drawer opens both, then closes the stash alone', async () => {
    h.handle().toggleStash();
    await settleLong();
    expect(h.root().classList.contains('open')).toBe(true);
    expect(stash.state.focus).toBe('stash');
    h.handle().toggleStash();
    await settle();
    expect(stash.state.open).toBe(false);
    expect(h.root().classList.contains('open')).toBe(true);
  });
});
```

(`h` is the file's shared harness; its `afterEach` destroys it. If the file's top-level `beforeEach` already creates `h`, the `h?.destroy()` above replaces it with the stash-carrying one.)

- [ ] **Step 2: Run it — it fails**

Run: `npx vitest run src/lib/tabs/TabDrawer.svelte.test.ts -t "hosts the stash"`
Expected: FAIL — `.stash-bar` missing, `toggleStash` not a function.

- [ ] **Step 3: Implement in `TabDrawer.svelte`**

3a. Imports — after `import WindowCarousel, { type CarouselHandle } from './WindowCarousel.svelte';` add:

```ts
  import StashBar from '../stash/StashBar.svelte';
  import StashDrawer, { type StashDrawerHandle } from '../stash/StashDrawer.svelte';
  import type { StashStore } from '../stash/stash-store.svelte';
  import type { StashEntry, TagChange } from '../stash/types';
  import { drawerLayout } from '../stash/drawer-width';
  import { focusDrawer, type DrawerFocus } from '../stash/stash-state';
```

3b. `TabDrawerHandle` — after `shortcutTarget(n: number): string | null | undefined;` add:

```ts
    /** ⌃S and View → Tabs → Stash (stash stage 04): open both drawers with the stash focused, or close the stash. */
    toggleStash(): void;
```

3c. Props — in the destructuring, after `onrenumber,` add `stash, onputaway, onstashopen, onstashremove, onstashtag,`; in the type, after `onrenumber?: (n: number) => Promise<RenumberResult>;` add:

```ts
    /** The window's stash (stash stage 04). Absent: no stash bar, no stash drawer. */
    stash?: StashStore;
    /** Put these tabs away (the drop zone, a drop on the stash drawer, «В тайник», ⌃T). */
    onputaway?: (tabIds: string[]) => void;
    /** Open a stash entry here; `before`: its drop position in the tab list, `undefined` for a click or Enter. */
    onstashopen?: (entry: StashEntry, before: string | null | undefined) => void;
    onstashremove?: (entry: StashEntry) => void;
    onstashtag?: (entry: StashEntry, change: TagChange) => void;
```

3d. State — after `let dragHintEl: HTMLElement | undefined = $state();` add:

```ts
  let stashHandle: StashDrawerHandle | undefined = $state();
  let stashBarEl: HTMLElement | undefined = $state();
  let viewport = $state(typeof window === 'undefined' ? 0 : window.innerWidth);
```

3e. Derived — after `const listLabel = $derived(t('tabs.notch.aria', { n: windowNumber ?? '' }));` add:

```ts
  const stashOpen = $derived(stash?.state.open ?? false);
  const focusStash = $derived(stashOpen && stash?.state.focus === 'stash');
  const layout = $derived(drawerLayout(viewport, stashOpen));
  /** Compact cards: the View setting, or both drawers squeezed side by side (D4). */
  const compactCards = $derived(compact || (stashOpen && layout.narrow));
  /** Paths open as tabs here: the stash drawer does not show them (D10). */
  const openHerePaths = $derived(new Set(list.tabs.flatMap((tab) => (tab.path === null ? [] : [tab.path]))));
```

3f. The handle effect — add `toggleStash: () => toggleStash(),` after `shortcutTarget: …,`.

3g. New effects, after the handle effect:

```ts
  $effect(() => {
    const onResize = () => {
      viewport = window.innerWidth;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  // The toast stack moves by the stash drawer's width (D19).
  $effect(() => {
    stash?.setWidth(layout.stash);
  });
```

3h. `openDrawer` — after `data.refresh(list.tabs);` add `void stash?.refreshCounts();`.

3i. `closeDrawer` — right after `if (!ds.open) return;` add:

```ts
    // The stash opens from this drawer and closes with it (spec «Esc»).
    if (stash?.state.open) stash.close();
```

3j. `scheduleHoverClose` — `if (!ds.open || ds.mode !== 'hover') return;` becomes:

```ts
    if (!ds.open || ds.mode !== 'hover' || stashOpen) return;
```

3k. After `function pinNow(): void { … }` add:

```ts
  // --- the stash drawer (stash stage 04) ---

  function openStash(): void {
    if (!stash) return;
    if (!ds.open) openDrawer('pinned');
    else pinNow();
    clearTimeout(hoverCloseTimer);
    stash.open();
  }

  function closeStash(): void {
    if (stash?.state.open) stash.close();
  }

  function toggleStash(): void {
    if (stash?.state.open) closeStash();
    else openStash();
  }

  function focusSide(side: DrawerFocus): void {
    stash?.update((s) => focusDrawer(s, side));
  }

  /** A click or Enter closes both drawers first, as activating a tab does; a drag keeps them open. */
  function openStashEntry(entry: StashEntry, before: string | null | undefined, close: boolean): void {
    if (close) closeDrawer();
    onstashopen?.(entry, before);
  }

  /** A press on a stash card opens it here (Task 20 makes a press that moves a drag). */
  function onStashPress(entry: StashEntry): void {
    openStashEntry(entry, undefined, true);
  }
```

3l. Markup — the root `<div class="tab-drawer" …>`: replace `class:compact` with `class:compact={compactCards}` and add after `class:car={car !== null}`:

```svelte
  class:stash-open={stashOpen}
  class:narrow={layout.narrow}
```

The `.drawer-wrap` div: add after `onpointerdown={trackShift}`:

```svelte
    style:width={stashOpen ? `${layout.tabs}px` : null}
    onpointerdowncapture={() => {
      if (stashOpen) focusSide('tabs');
    }}
```

In the `TabCard` call, `{compact}` becomes `compact={compactCards}`.

After the `.hint` div (before `</aside>`):

```svelte
      {#if stash}
        <StashBar
          counts={stash.counts}
          open={stashOpen}
          dropCount={null}
          hot={false}
          got={false}
          onclick={toggleStash}
          bind:el={stashBarEl}
        />
      {/if}
```

After the closing `</div>` of `.drawer-wrap` (before `{#if drag}`):

```svelte
  {#if stash}
    <StashDrawer
      bind:handle={stashHandle}
      {stash}
      openHere={openHerePaths}
      width={layout.stash}
      narrow={layout.narrow}
      compact={compactCards}
      {windowNumber}
      dropReady={false}
      dropHot={false}
      draggingId={null}
      onpress={onStashPress}
      onopen={(entry) => openStashEntry(entry, undefined, true)}
      onremove={(entry) => onstashremove?.(entry)}
      onsettag={(entry, change) => onstashtag?.(entry, change)}
      onfocusrequest={() => {
        if (stashOpen) focusSide('stash');
      }}
    />
  {/if}
```

3m. CSS — the `.drawer-wrap` rule's `transition: transform 0.34s var(--tabs-ease);` becomes:

```css
    transition:
      transform 0.34s var(--tabs-ease),
      width 0.34s var(--tabs-ease);
```

and after the `.car .scrim` rule add:

```css
  /* Stash stage 04 (D17): both drawers open veil the page like the carousel. */
  .stash-open .scrim {
    opacity: 0.82;
  }
```

- [ ] **Step 4: Run the drawer tests — all pass**

Run: `npx vitest run src/lib/tabs/TabDrawer.svelte.test.ts`
Expected: PASS — the 4 new tests and every existing one (no stash passed there: no bar, no stash drawer, `compactCards === compact`).

- [ ] **Step 5: Type check and commit**

Run: `npm run check` — 0 errors.

```bash
git add src/lib/tabs/TabDrawer.svelte src/lib/tabs/TabDrawer.svelte.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): the tabs drawer hosts the stash bar and the stash drawer

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/tabs/TabDrawer.svelte src/lib/tabs/TabDrawer.svelte.test.ts
```

---

## Task 19: Keys and focus across the two drawers — ←/→, routing, Esc, rim, ⌃T targets

**Files:**
- Modify: `src/lib/tabs/TabDrawer.svelte`
- Modify: `src/lib/tabs/TabDrawer.svelte.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/tabs/TabDrawer.svelte.test.ts`:

```ts
describe('TabDrawer — one keyboard for two drawers (stash stage 04)', () => {
  let stash: StashStore;
  const onstashopen = vi.fn();

  beforeEach(async () => {
    h?.destroy();
    stash = fakeStash();
    onstashopen.mockClear();
    h = setup(initialList(), { stash, onstashopen, onputaway: vi.fn(), onstashremove: vi.fn(), onstashtag: vi.fn() });
    h.handle().toggle();
    await settle();
  });

  const page = () => h.root().parentElement!;
  const stashQuery = () => page().querySelector('.stash-drawer .s-q')?.textContent ?? '';

  it('→ opens the stash with the keys; letters filter the stash, not the tabs', async () => {
    press('ArrowRight');
    await settleLong();
    expect(page().querySelector('.stash-drawer.focused')).not.toBeNull();
    expect(page().querySelector('#tab-drawer.focused')).toBeNull();
    press('b');
    await settle();
    expect(stashQuery()).toBe('b');
    expect(query()).toBe('');
    expect(h.editorKeys).toEqual([]);
  });

  it('← gives the keys back; the tabs drawer glows and filters', async () => {
    press('ArrowRight');
    await settleLong();
    press('ArrowLeft');
    await settle();
    expect(page().querySelector('#tab-drawer.focused')).not.toBeNull();
    expect(page().querySelector('.stash-drawer.focused')).toBeNull();
    press('g');
    await settle();
    expect(query()).toBe('g');
    expect(stashQuery()).toBe('');
  });

  it('Esc in the stash clears its query, then closes the stash alone', async () => {
    press('ArrowRight');
    await settleLong();
    press('o');
    await settle();
    press('Escape');
    await settle();
    expect(stashQuery()).toBe('');
    expect(stash.state.open).toBe(true);
    press('Escape');
    await settle();
    expect(stash.state.open).toBe(false);
    expect(h.root().classList.contains('open')).toBe(true);
  });

  it('Esc in the tabs drawer closes both', async () => {
    press('ArrowRight');
    await settleLong();
    press('ArrowLeft');
    await settle();
    press('Escape');
    await settle();
    expect(h.root().classList.contains('open')).toBe(false);
    expect(stash.state.open).toBe(false);
  });

  it('Enter opens the stash top result here and closes both drawers', async () => {
    press('ArrowRight');
    await settleLong();
    press('b');
    await settle();
    press('Enter');
    await settle();
    expect(onstashopen).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }), undefined);
    expect(h.root().classList.contains('open')).toBe(false);
  });

  it('⌃T targets: the selection, the ring, the active tab — nothing while the stash has the keys', async () => {
    expect(h.handle().putAwayTargets()).toEqual(['a']);
    shiftClick('c');
    await settle();
    expect(h.handle().putAwayTargets()).toEqual(['c']);
    press('ArrowRight');
    await settleLong();
    expect(h.handle().putAwayTargets()).toBeNull();
    h.handle().close();
    await settle();
    expect(h.handle().putAwayTargets()).toBeUndefined();
  });
});
```

(`shiftClick`, `press`, `query`, `el`, `settle` are the file's existing helpers.)

- [ ] **Step 2: Run them — they fail**

Run: `npx vitest run src/lib/tabs/TabDrawer.svelte.test.ts -t "one keyboard"`
Expected: FAIL — → does nothing, `putAwayTargets` missing.

- [ ] **Step 3: Implement**

3a. Imports: extend the `stash-state` import to `import { arrowFocus, focusDrawer, type DrawerFocus } from '../stash/stash-state';`.

3b. `TabDrawerHandle` — after `toggleStash(): void;` add:

```ts
    /**
     * ⌃T while the drawer is open (mockup `stashByKey`): the ⇧-selection, else
     * the card under the keyboard ring, else the active tab. `null`: the stash
     * has the keys — ⌃T does nothing. `undefined`: the drawer is closed — ⌃T
     * puts away the active document as before.
     */
    putAwayTargets(): string[] | null | undefined;
```

In the handle effect add:

```ts
      putAwayTargets: () => {
        if (!ds.open) return undefined;
        if (focusStash) return null;
        const chosen = selectedIds();
        if (chosen.length > 0) return chosen;
        const kb = kbTarget(ds, visible);
        if (kb) return [kb];
        return list.activeId ? [list.activeId] : [];
      },
```

3c. DOM focus follows the drawer that has the keys (D5) — add after the `$effect(() => { if (isOpen) focusList(); });` effect:

```ts
  // Stash stage 04 (D5): DOM focus follows the drawer that has the keys, so
  // keys the drawers do not use (Space, Tab) still land in a drawer, never in
  // the document behind them. Routing itself reads the store, not the DOM.
  $effect(() => {
    if (!stash || !ds.open) return;
    const toStash = focusStash;
    void tick().then(() => {
      if (!ds.open) return;
      const active = document.activeElement;
      if (toStash) stashHandle?.focus();
      else if (!(active instanceof Element && (asideEl?.contains(active) || active.closest('.notch-edit')))) {
        listEl?.focus({ preventScroll: true });
      }
    });
  });
```

3d. `onKeyDown` — replace

```ts
    // The notch's number input takes digits, Enter, Esc and Backspace itself.
    if (e.target instanceof Element && e.target.closest('.notch-edit')) return;
```

with

```ts
    // The notch's number input and a stash card's tag input take their keys themselves.
    if (e.target instanceof Element && e.target.closest('.notch-edit, .tag-edit')) return;
```

and insert right before `const action = drawerKeyAction(e, ds.query, mac, …);`:

```ts
    // Stash stage 04 (D6): bare ←/→ move the keys between the drawers — → opens
    // the stash — and while the stash has them every key is routed to it.
    if (stash && car === null) {
      const side = arrowFocus(e);
      if (side) {
        e.preventDefault();
        e.stopPropagation();
        if (side === 'right') {
          if (!stash.state.open) openStash();
          else focusSide('stash');
        } else {
          focusSide('tabs');
        }
        return;
      }
      if (focusStash) {
        if (stashHandle?.key(e)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
    }
```

(Esc in the stash is `escapeStash` inside `stashHandle.key`; when it closes the stash, the focus effect above hands the DOM focus back to the tab list. Esc in the tabs drawer is the existing `escapeState` → `closeDrawer`, which closes the stash too.)

3e. Markup — the `<aside class="drawer" id="tab-drawer" …>`: add `class:focused={stashOpen && !focusStash}`. In `.drawer-title`, after the `type-hint` `<small>`:

```svelte
          {#if stash}<small class="focus-hint"><kbd>←</kbd> {t('stash.drawer.focus_tabs')}</small>{/if}
```

3f. CSS — add after the `.open .drawer { … }` rule:

```css
  .drawer {
    --acc: var(--tabs-brand-a);
  }

  /* Stash stage 04: with both drawers open, the one with the keys shows a rim
     in its own colour (mockup `.drawer::after`); the other is not dimmed. */
  .drawer::after {
    content: '';
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s;
    box-shadow:
      inset 0 0 0 1.5px color-mix(in oklab, var(--acc) 65%, transparent),
      0 0 16px 1px color-mix(in oklab, var(--acc) 30%, transparent);
  }

  .stash-open .drawer.focused::after {
    opacity: 1;
  }

  .drawer-title .focus-hint {
    display: none;
  }

  .focus-hint kbd {
    font-size: 11px;
    color: var(--text-subtle);
  }

  /* Without the keys, the header says how to get them back. */
  .stash-open .drawer:not(.focused) .drawer-title .focus-hint {
    display: block;
  }

  .stash-open .drawer:not(.focused) .type-hint,
  .stash-open .drawer:not(.focused) .sel-hint {
    display: none;
  }

  .narrow.stash-open .sorts .lbl,
  .narrow.stash-open .sorts kbd {
    display: none;
  }
```

and in the `prefers-reduced-motion` block add `.drawer::after` to the `transition-duration: 0.01s !important` list (with `.drawer-wrap, .scrim`).

- [ ] **Step 4: Run the drawer tests — all pass**

Run: `npx vitest run src/lib/tabs/TabDrawer.svelte.test.ts`
Expected: PASS (6 new + all existing — without a stash the router's new block is skipped).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tabs/TabDrawer.svelte src/lib/tabs/TabDrawer.svelte.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): ←/→ between drawers, stash key routing, Esc, focus rim, ⌃T targets

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/tabs/TabDrawer.svelte src/lib/tabs/TabDrawer.svelte.test.ts
```

---

## Task 20: Drags both ways — the drop zone, the stash drawer, the tab list; «В тайник»; the carousel band

**Files:**
- Modify: `src/lib/tabs/TabDrawer.svelte`
- Modify: `src/lib/tabs/WindowCarousel.svelte`
- Modify: `src/lib/tabs/TabDrawer.svelte.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/tabs/TabDrawer.svelte.test.ts`:

```ts
describe('TabDrawer — cards cross between the drawers (stash stage 04)', () => {
  let stash: StashStore;
  const onstashopen = vi.fn();
  const onputaway = vi.fn();
  const page = () => h.root().parentElement!;

  beforeEach(async () => {
    h?.destroy();
    stash = fakeStash();
    onstashopen.mockClear();
    onputaway.mockClear();
    h = setup(initialList(), { stash, onstashopen, onputaway, onstashremove: vi.fn(), onstashtag: vi.fn() });
    h.handle().toggle();
    await settle();
  });

  function drag(from: Element, to: { x: number; y: number }, start = { x: 10, y: 10 }): void {
    pointer(from, 'pointerdown', { button: 0, buttons: 1, clientX: start.x, clientY: start.y });
    pointer(window, 'pointermove', { buttons: 1, clientX: to.x, clientY: to.y });
    flushSync();
    pointer(window, 'pointermove', { buttons: 1, clientX: to.x + 1, clientY: to.y });
    flushSync();
  }

  it('a tab card dragged shows the drop zone; dropped on it, the tab is put away', async () => {
    el('.stash-bar').getBoundingClientRect = () => new DOMRect(0, 700, 400, 58);
    drag(card('b'), { x: 50, y: 720 });
    expect(el('.stash-bar').classList.contains('dropmode')).toBe(true);
    expect(el('.stash-bar').classList.contains('hot')).toBe(true);
    expect(page().querySelector('.ghost.as-stash')).not.toBeNull();
    pointer(window, 'pointerup', { clientX: 51, clientY: 720 });
    await settle();
    expect(onputaway).toHaveBeenCalledWith(['b']);
    expect(h.onreorder).not.toHaveBeenCalled();
  });

  it('dropped on the open stash drawer, it is put away too', async () => {
    h.handle().toggleStash();
    await settleLong();
    page().querySelector<HTMLElement>('.stash-wrap')!.getBoundingClientRect = () => new DOMRect(600, 0, 400, 768);
    drag(card('b'), { x: 700, y: 300 });
    expect(page().querySelector('.stash-drawer.drop-hot')).not.toBeNull();
    pointer(window, 'pointerup', { clientX: 701, clientY: 300 });
    await settle();
    expect(onputaway).toHaveBeenCalledWith(['b']);
    expect(h.onmove).not.toHaveBeenCalled();
  });

  it('a stash card dropped on the tab list opens there, both drawers stay', async () => {
    h.handle().toggleStash();
    await settleLong();
    el('.tab-list').getBoundingClientRect = () => new DOMRect(0, 0, 300, 600);
    el('#tab-drawer').getBoundingClientRect = () => new DOMRect(0, 0, 420, 768);
    const s2 = page().querySelector('[data-stash-id="s2"]')!;
    drag(s2, { x: 100, y: 300 }, { x: 700, y: 100 });
    expect(page().querySelector('.ghost.as-open')).not.toBeNull();
    pointer(window, 'pointerup', { clientX: 101, clientY: 300 });
    await settle();
    expect(onstashopen).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }), null);
    expect(h.root().classList.contains('open')).toBe(true);
  });

  it('a click on a stash card opens it here and closes both', async () => {
    h.handle().toggleStash();
    await settleLong();
    const s1 = page().querySelector('[data-stash-id="s1"]')!;
    pointer(s1, 'pointerdown', { button: 0, buttons: 1, clientX: 700, clientY: 100 });
    pointer(window, 'pointerup', { clientX: 700, clientY: 100 });
    await settle();
    expect(onstashopen).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), undefined);
    expect(h.root().classList.contains('open')).toBe(false);
  });

  it('«В тайник» in the selection bar puts the selection away', async () => {
    shiftClick('b');
    shiftClick('c');
    await settle();
    const button = [...page().querySelectorAll<HTMLButtonElement>('.sel-bar button')].find(
      (b) => b.textContent === 'To stash'
    )!;
    button.click();
    await settle();
    expect(onputaway).toHaveBeenCalledWith(['b', 'c']);
  });
});
```

- [ ] **Step 2: Run them — they fail**

Run: `npx vitest run src/lib/tabs/TabDrawer.svelte.test.ts -t "cross between"`
Expected: FAIL — no drop zone, no stash drag, no «В тайник».

- [ ] **Step 3: `WindowCarousel` takes a right edge**

In `src/lib/tabs/WindowCarousel.svelte`: add `right = 0,` after `left,` in the props destructuring; in the type after `left: number;`:

```ts
    /** Stash stage 04: the stash drawer's width while it is open — the carousel stays between the drawers (D20). */
    right?: number;
```

and after `style:left="{left}px"` add `style:right="{right}px"`.

- [ ] **Step 4: Implement in `TabDrawer.svelte`**

4a. Imports: `import { drawerLayout, pageBand, type Band } from '../stash/drawer-width';` (replacing the Task 18 line), and add:

```ts
  import { resolveDrop, type DropTarget } from '../stash/drop-target';
  import { entryTitle } from '../stash/stash-view';
```

4b. Replace the whole `interface DragState { … }` with:

```ts
  interface DragState {
    /** Stash stage 04: a tab card, or a stash card. */
    src: 'tabs' | 'stash';
    /** Tab ids (tabs), or the one entry id (stash). */
    ids: string[];
    /** The dragged tab (tabs only). */
    lead: TabMeta | null;
    /** The dragged entry (stash only). */
    entry: StashEntry | null;
    x: number;
    y: number;
    /** Where on the card it was grabbed. */
    ox: number;
    oy: number;
    width: number;
    before: string | null;
    inList: boolean;
    target: DropTarget;
  }
```

4c. `CarouselState` — after `left: number;` add `right: number;`.

4d. State — after `let viewport = …` add:

```ts
  let barGot = $state(false);
  let barGotTimer: ReturnType<typeof setTimeout> | undefined;
```

and add `barGotTimer` to the timer list in the destroy effect (`for (const timer of [hoverOpenTimer, …, carCloseTimer, barGotTimer])`).

4e. `openCarousel` — replace `left: asideEl?.getBoundingClientRect().right ?? 0,` with:

```ts
      left: asideEl?.getBoundingClientRect().right ?? 0,
      right: (() => {
        const stashLeft = stashOpen ? (stashHandle?.left() ?? null) : null;
        return stashLeft === null ? 0 : Math.max(0, window.innerWidth - stashLeft);
      })(),
```

4f. `openMoveKeys` — at its start add:

```ts
    // No page between squeezed drawers for the carousel (D20): the stash steps aside.
    if (stashOpen && layout.narrow) closeStash();
```

4g. Replace `followCarousel` with:

```ts
  /** The page band the carousel may use: right of the tabs drawer, left of the stash drawer (D20). */
  function carouselBand(): Band | null {
    const tabsRight = asideEl?.getBoundingClientRect().right ?? 0;
    const stashLeft = stashOpen ? (stashHandle?.left() ?? null) : null;
    return pageBand(tabsRight, stashLeft, window.innerWidth, layout.narrow);
  }

  /** Over the page between the drawers: the carousel; anywhere else: gone (mockup `carouselFollow`). */
  function followCarousel(x: number, y: number, overPage: boolean): void {
    const d = drag;
    if (!d) return;
    const band = carouselBand();
    const want = overPage && band !== null && wantsCarousel(x, y, band.left, band.right, window.innerHeight);
    if (want && !car) openCarousel('drag', d.ids);
    else if (!want && car?.mode === 'drag' && car.got === null) closeCarousel();
    refreshHot();
  }
```

4h. `beginDrag` — the `drag = { ids, lead, … }` line becomes:

```ts
    drag = {
      src: 'tabs',
      ids,
      lead,
      entry: null,
      x: sx,
      y: sy,
      ox: sx - r.left,
      oy: sy - r.top,
      width: r.width,
      before: null,
      inList: false,
      target: 'none',
    };
```

4i. After `overList` add:

```ts
  /** A laid-out element under the point (a zero box — hidden, or jsdom — never is). */
  function inside(el: Element | null | undefined, x: number, y: number): boolean {
    const r = el?.getBoundingClientRect();
    return !!r && r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function dropTargetAt(src: 'tabs' | 'stash', x: number, y: number): DropTarget {
    return resolveDrop(
      src,
      {
        stashDrawer: stashOpen && (stashHandle?.contains(x, y) ?? false),
        stashZone: !!stash && inside(stashBarEl, x, y),
        list: overList(x, y),
        tabsDrawer: inside(asideEl, x, y),
      },
      !!ds.query
    );
  }
```

4j. Replace `dragMove` with:

```ts
  function dragMove(ev: PointerEvent): void {
    const d = drag;
    if (!d) return;
    const target = dropTargetAt(d.src, ev.clientX, ev.clientY);
    // A filtered view has no manual order to drop into (mockup).
    const inList = !ds.query && overList(ev.clientX, ev.clientY) && (target === 'list' || target === 'tabs-drawer');
    drag = {
      ...d,
      x: ev.clientX,
      y: ev.clientY,
      target,
      inList,
      before: inList ? dropBefore(cardBoxes(), ev.clientY, new Set(d.src === 'tabs' ? d.ids : [])) : null,
    };
    if (inList) autoScroll(ev.clientY);
    if (d.src === 'tabs') followCarousel(ev.clientX, ev.clientY, target === 'page');
  }
```

4k. Replace `finishDrag` with:

```ts
  function finishDrag(dropped: boolean): void {
    const d = drag;
    drag = null;
    windowsFetch = null;
    const c = car;
    if (d?.src === 'stash') {
      if (dropped && d.entry && d.target === 'tabs-drawer') openStashEntry(d.entry, d.inList ? d.before : undefined, false);
    } else if (dropped && c?.mode === 'drag' && c.hot !== null) {
      pick(c.hot);
    } else {
      if (c?.mode === 'drag') closeCarousel();
      if (dropped && d && (d.target === 'stash-zone' || d.target === 'stash-drawer')) putAway(d.ids);
      else if (dropped && d?.inList) onreorder(moveIds(list.tabs.map((tab) => tab.id), d.ids, d.before));
    }
    if (ds.mode === 'hover' && !inWrap) scheduleHoverClose();
  }
```

4l. Replace the Task 18 `onStashPress` with:

```ts
  /** A press on a stash card: a click opens it here and closes both; a move drags it (the tabs drawer's one drag machine, D1). */
  function onStashPress(entry: StashEntry, card: HTMLElement, e: PointerEvent): void {
    endGesture?.();
    if (car?.mode === 'keys') closeCarousel();
    gesture = 'press';
    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    track(
      (ev) => {
        if (!dragging && pastThreshold(ev.clientX - sx, ev.clientY - sy)) dragging = beginStashDrag(entry, card, sx, sy);
        if (dragging) dragMove(ev);
      },
      (ev) => {
        gesture = null;
        if (dragging) finishDrag(ev !== null);
        else if (ev) openStashEntry(entry, undefined, true);
      }
    );
  }

  function beginStashDrag(entry: StashEntry, card: HTMLElement, sx: number, sy: number): boolean {
    gesture = 'drag';
    clearTimeout(expandTimer);
    expandedId = null;
    const r = card.getBoundingClientRect();
    drag = {
      src: 'stash',
      ids: [entry.id],
      lead: null,
      entry,
      x: sx,
      y: sy,
      ox: sx - r.left,
      oy: sy - r.top,
      width: r.width,
      before: null,
      inList: false,
      target: 'none',
    };
    return true;
  }

  /** Tabs → stash (D8): the app puts them away and closes them; the bar gives a short pulse. */
  function putAway(ids: string[]): void {
    if (ids.length === 0 || !onputaway) return;
    ds = clearSelection(ds);
    onputaway(ids);
    barGot = false;
    clearTimeout(barGotTimer);
    requestAnimationFrame(() => {
      barGot = true;
      barGotTimer = setTimeout(() => {
        barGot = false;
      }, 720);
    });
  }

  function putAwaySelected(): void {
    putAway(selectedIds());
  }

  /** The ghost's grey line for a stash card. */
  function stashGhostMeta(entry: StashEntry): string {
    if (entry.kind === 'note') return t('stash.ghost.note_meta');
    if (entry.repo && entry.branch) return `${entry.repo} · ⎇ ${entry.branch}`;
    return entry.repo ?? '';
  }
```

4m. Markup — the selection bar: first button inside `<span class="acts">`:

```svelte
          {#if onputaway}
            <button type="button" title={t('tabs.selection.to_stash_title')} onclick={putAwaySelected}
              >{t('tabs.selection.to_stash')}</button
            >
          {/if}
```

The `StashBar`: `dropCount={null}` → `dropCount={drag?.src === 'tabs' ? drag.ids.length : null}`, `hot={false}` → `hot={drag?.target === 'stash-zone'}`, `got={false}` → `got={barGot}`.

The `StashDrawer`: `dropReady={false}` → `dropReady={drag?.src === 'tabs'}`, `dropHot={false}` → `dropHot={drag?.target === 'stash-drawer'}`, `draggingId={null}` → `draggingId={drag?.src === 'stash' ? (drag.entry?.id ?? null) : null}`.

Replace the whole `{#if drag} … {/if}` ghost block with:

```svelte
  {#if drag}
    {@const inCar = car?.mode === 'drag'}
    {@const hotItem = car && car.hot !== null ? car.items?.[car.hot] : undefined}
    {@const toStash = drag.target === 'stash-zone' || drag.target === 'stash-drawer'}
    {@const toOpen = drag.src === 'stash' && drag.target === 'tabs-drawer'}
    <!-- pointer-events: none (styles): the carousel's hit test must see the thumbnail under it. -->
    <div
      class="ghost"
      class:multi={drag.ids.length > 1}
      class:from-stash={drag.src === 'stash'}
      class:cancel={!drag.inList && !hotItem && !toStash && !toOpen}
      class:as-car={inCar}
      class:as-stash={toStash}
      class:as-open={toOpen}
      aria-hidden="true"
      style:width={inCar ? null : toStash ? '240px' : `${drag.width}px`}
      style:transform={inCar
        ? `translate(${drag.x - 40}px, ${drag.y - 12}px)`
        : toStash
          ? `translate(${drag.x - 40}px, ${drag.y - 112}px)`
          : toOpen
            ? `translate(${drag.x - drag.ox}px, ${drag.y - drag.oy}px)`
            : `translate(${drag.x - drag.ox}px, ${drag.y - drag.oy}px) rotate(-1.2deg)`}
    >
      <div class="ghost-bar">
        <i></i><i></i><i></i><span
          >{hotItem
            ? hotItem.kind === 'new'
              ? t('tabs.carousel.new_window_short')
              : `→ #${hotItem.number ?? '?'}`
            : toStash
              ? t('stash.ghost.to_stash')
              : toOpen
                ? t('stash.ghost.open')
                : ''}</span
        >
      </div>
      <div class="ghost-body">
        <div class="ghost-name">
          {drag.entry ? entryTitle(drag.entry, t('stash.untitled')) : tabName(drag.lead?.path ?? null)}
        </div>
        <div class="ghost-meta">{drag.entry ? stashGhostMeta(drag.entry) : drag.lead ? metaText(drag.lead) : ''}</div>
      </div>
      {#if drag.ids.length > 1}<div class="ghost-count">{drag.ids.length}</div>{/if}
    </div>
  {/if}
```

(Over a stash target the ghost shrinks and lifts above the pointer, so the zone under it stays readable — mockup `dragAt`.)

In the `WindowCarousel` call add `right={car.right}` after `left={car.left}`.

4n. CSS — after the `.ghost.as-car .ghost-bar` rule add:

```css
  /* Stash stage 04: a stash card in flight, and a card over a stash target / the tab list. */
  .ghost.from-stash {
    border-color: var(--stash-line);
  }

  .ghost.as-stash {
    outline: 2px solid var(--color-stash);
  }

  .ghost.as-open {
    outline: 2px solid var(--tabs-brand-a);
  }

  .ghost.as-stash .ghost-bar,
  .ghost.as-open .ghost-bar {
    height: 24px;
  }
```

- [ ] **Step 5: Run the drawer and carousel tests — all pass**

Run: `npx vitest run src/lib/tabs/TabDrawer.svelte.test.ts src/lib/tabs/WindowCarousel.svelte.test.ts`
Expected: PASS — 5 new tests, and the plan-05 carousel tests unchanged (without a stash the band is `[aside right, innerWidth]`, exactly the old `wantsCarousel` call; a drop over the list is `'list'` as before).

- [ ] **Step 6: Type check and commit**

Run: `npm run check` — 0 errors.

```bash
git add src/lib/tabs/TabDrawer.svelte src/lib/tabs/WindowCarousel.svelte src/lib/tabs/TabDrawer.svelte.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): drag tabs into the stash and stash cards into the tabs; «В тайник»

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/tabs/TabDrawer.svelte src/lib/tabs/WindowCarousel.svelte src/lib/tabs/TabDrawer.svelte.test.ts
```

---

## Task 21: The `stash` toast kind, and a toast stack that moves left of the stash

**Files:**
- Modify: `src/lib/toasts.svelte.ts`
- Modify: `src/lib/ToastStack.svelte`
- Create: `src/lib/ToastStack.stash.svelte.test.ts`

If Task 0 found a stage-03 toast kind named `stash`, merge: keep its fields, add `note: StashToastNote` as the payload for this stage's notices, and render them with the block below inside its branch.

- [ ] **Step 1: Write the failing test**

`src/lib/ToastStack.stash.svelte.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ToastStack from './ToastStack.svelte';
import { createToastStore } from './toasts.svelte';
import { installCatalog } from './i18n';

let target: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => installCatalog('ru'));
afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
  installCatalog('en');
});

function render(right?: number) {
  const store = createToastStore();
  const onRevealWindow = vi.fn();
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(ToastStack, { target, props: { store, onRevealWindow, right } });
  return { store, onRevealWindow };
}

describe('ToastStack — stash notices', () => {
  it('renders a stash note as text and dim text', () => {
    const { store } = render();
    store.push({ kind: 'stash', note: { what: 'removed', title: 'a.md' } });
    flushSync();
    expect(target.querySelector('.md-toast-text')?.textContent?.trim()).toBe('a.md убран из тайника');
    expect(target.querySelector('.md-toast-dim')?.textContent?.trim()).toBe('· файл остался на месте');
  });

  it('a pull that failed offers «Перейти» to the holder', () => {
    const { store, onRevealWindow } = render();
    store.push({ kind: 'stash', note: { what: 'pull-failed', number: 19, label: 'editor-19' } });
    flushSync();
    target.querySelector<HTMLButtonElement>('.md-toast-action')!.click();
    expect(onRevealWindow).toHaveBeenCalledWith('editor-19');
  });

  it('a newer stash notice replaces the last', () => {
    const { store } = render();
    store.push({ kind: 'stash', note: { what: 'widened' } });
    store.push({ kind: 'stash', note: { what: 'removed', title: 'b.md' } });
    flushSync();
    expect(target.querySelectorAll('.md-toast')).toHaveLength(1);
  });

  it('moves left of the open stash drawer', () => {
    const { store } = render(416);
    store.push({ kind: 'stash', note: { what: 'widened' } });
    flushSync();
    expect(target.querySelector<HTMLElement>('.md-toast-stack')?.style.right).toBe('416px');
  });
});
```

- [ ] **Step 2: Run it — it fails**

Run: `npx vitest run src/lib/ToastStack.stash.svelte.test.ts`
Expected: FAIL (type error on `kind: 'stash'` at runtime is fine; the rendering assertions fail).

- [ ] **Step 3: Implement**

`src/lib/toasts.svelte.ts`: at the top add `import type { StashToastNote } from './stash/stash-toast';`. In `ToastPayload`, before `| { kind: 'update'; …`, add:

```ts
  /**
   * Stash stage 04: every stash notice — put away, opened / moved here,
   * removed, the window widened, a pull that failed, an IPC error. One kind,
   * so a newer notice replaces the last; App dismisses the quiet ones itself
   * (like `tabs-moved`), a failure stays until closed. Text: `stashToastText`.
   */
  | { kind: 'stash'; note: StashToastNote }
```

and in `ORDER`, next to `'window-number': 4,` add `stash: 4,`.

`src/lib/ToastStack.svelte`: import `import { stashToastText } from './stash/stash-toast';`. In the props, after `onRevealWindow,` add `right,` and in the type:

```ts
    /** Stash stage 04 (D19): px from the window's right edge while the stash drawer is open. */
    right?: number;
```

Change `<div class="md-toast-stack">` to `<div class="md-toast-stack" style:right={right === undefined ? null : `${right}px`}>`. After the `{:else if toast.payload.kind === 'window-number'} … ` block (before `{:else if toast.payload.kind === 'reload-error'}`), add:

```svelte
        {:else if toast.payload.kind === 'stash'}
          {@const note = toast.payload.note}
          {@const text = stashToastText(note)}
          <span class="md-toast-text">{text.text}</span>
          {#if text.dim}<span class="md-toast-dim">{text.dim}</span>{/if}
          {#if note.what === 'pull-failed'}
            <button
              class="md-toast-cmd md-toast-action"
              onclick={() => {
                onRevealWindow?.(note.label);
                dismiss(toast);
              }}>{t('toast.stash.go')}</button
            >
          {/if}
```

- [ ] **Step 4: Run the toast tests — they pass**

Run: `npx vitest run src/lib/ToastStack.stash.svelte.test.ts src/lib/ToastStack.svelte.test.ts src/lib/toasts.svelte.test.ts`
Expected: PASS (4 new, the rest unchanged). `npm run check` — 0 errors (the `ORDER` record is exhaustive over `ToastKind`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/toasts.svelte.ts src/lib/ToastStack.svelte src/lib/ToastStack.stash.svelte.test.ts
git commit -m "$(cat <<'EOF'
feat(stash): stash toast kind; the toast stack steps left of the stash drawer

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/toasts.svelte.ts src/lib/ToastStack.svelte src/lib/ToastStack.stash.svelte.test.ts
```

---

## Task 22: Wire it into the app

**Files:**
- Modify: `src/App.svelte`

No new unit test: every decision below is a tested module; this task is wiring, verified by `npm run check`, the full suite and Tasks 23–24.

- [ ] **Step 1: Imports**

`import { onMount } from 'svelte';` becomes `import { onMount, untrack } from 'svelte';`. Add `onTabPull` to the existing import from `./lib/tauri/events`. Add:

```ts
  import { createStashStore } from './lib/stash/stash-store.svelte';
  import {
    listAllEntries,
    onStashChanged,
    requestTabMove,
    stashCounts,
    stashDelete,
    stashPutAway,
    stashTag,
    stashTouchOpened,
    tabHolders,
    windowRepo,
  } from './lib/stash/ipc';
  import { putAwayNote, putAwayTabs } from './lib/stash/put-away';
  import { PULL_WAIT_MS, openFromStash } from './lib/stash/open-from-stash';
  import { restoreWindow, widenForStash, type WidenMemo } from './lib/stash/window-widen';
  import { ctrlSHandler } from './lib/stash/stash-keys';
  import { entryTitle } from './lib/stash/stash-view';
  import type { StashToastNote } from './lib/stash/stash-toast';
  import type { StashEntry, TagChange } from './lib/stash/types';
  import { moveIds } from './lib/tabs/drawer-geometry';
```

(Use stage 03's wrapper names from `$QA/substitutions.md` where they differ. If `moveIds` is already imported, skip that line.)

- [ ] **Step 2: The store and the handlers**

Right after `let carouselOn = $state(false);` add:

```ts
  // --- Stash drawer (stash stage 04) ---

  /** This window's stash drawer: entries, counts, holders, the drawer pair's state. */
  const stashStore = createStashStore({
    list: () => listAllEntries(),
    counts: () => stashCounts({}),
    holders: (paths) => tabHolders(paths),
    windowRepo: () => windowRepo(),
  });

  function stashUntitled(): string {
    return t('stash.untitled');
  }

  /** A stash notice that answers a gesture and goes by itself, like «Перенесено в #N». */
  function quietStashToast(note: StashToastNote): void {
    quietToast({ kind: 'stash', note });
  }

  /** Tabs → stash (D8): one put-away, then the ⌘W path for each. */
  async function putAway(tabIds: string[]): Promise<void> {
    await tabSourcesReady;
    const chip = stashStore.state.open ? stashStore.state.repoChip : null;
    const outcome = await putAwayTabs(tabIds, {
      tabs: () => tabList.tabs,
      putAway: (paths) => stashPutAway({ paths }),
      close: (ids) => tabs.closeTabs(ids),
    });
    if (outcome.kind === 'failed') {
      toasts.push({ kind: 'stash', note: { what: 'error', message: outcome.error } });
      return;
    }
    stashStore.upsert(outcome.results.map((r) => r.entry));
    stashStore.markPulse(outcome.results.filter((r) => !r.created).map((r) => r.entry.id));
    if (outcome.results.length > 0 || outcome.closedEmpty > 0) {
      quietStashToast(putAwayNote(outcome, chip, stashUntitled()));
    }
    void stashStore.refreshCounts();
  }

  /** A pulled tab has `PULL_WAIT_MS` to arrive (`tabs-arrive`); then the human hears either way. */
  function awaitPulled(path: string, title: string, isNote: boolean, number: number | null, label: string): void {
    const started = Date.now();
    const check = (): void => {
      if (tabs.findByPath(path)) {
        quietStashToast({ what: 'opened', title, isNote, from: number });
        return;
      }
      if (Date.now() - started >= PULL_WAIT_MS) {
        toasts.push({ kind: 'stash', note: { what: 'pull-failed', number, label } });
        return;
      }
      setTimeout(check, 200);
    };
    setTimeout(check, 200);
  }

  /** Stash → tabs (D9). */
  async function openStashEntry(entry: StashEntry, before: string | null | undefined): Promise<void> {
    await tabSourcesReady;
    const title = entryTitle(entry, stashUntitled());
    const isNote = entry.kind === 'note';
    const opened = await openFromStash(entry, before, {
      requestMove: (path) => requestTabMove(path),
      activate: (tabId) => tabs.activate(tabId),
      openPath: (path, position) => tabs.openPath(path, position),
      has: (path) => tabs.findByPath(path) !== undefined,
      place: (path, at) => {
        const tab = tabs.findByPath(path);
        if (tab) void tabs.reorder(moveIds(tabList.tabs.map((x) => x.id), [tab.id], at));
      },
      touch: (path) => stashTouchOpened(path),
    });
    if (opened.kind === 'opened') quietStashToast({ what: 'opened', title, isNote, from: null });
    else if (opened.kind === 'pulled') awaitPulled(entry.path, title, isNote, opened.number, opened.label);
    else if (opened.kind === 'failed' && opened.error !== null) {
      toasts.push({ kind: 'stash', note: { what: 'error', message: opened.error } });
    }
  }

  /** «убрать из тайника» (D13): file refs only; the file stays. */
  async function removeStashEntry(entry: StashEntry): Promise<void> {
    if (entry.kind !== 'file') return;
    try {
      await stashDelete(entry.id);
    } catch (err) {
      toasts.push({ kind: 'stash', note: { what: 'error', message: String(err) } });
      return;
    }
    stashStore.remove(entry.id);
    quietStashToast({ what: 'removed', title: entryTitle(entry, stashUntitled()) });
    void stashStore.refreshCounts();
  }

  async function tagStashEntry(entry: StashEntry, change: TagChange): Promise<void> {
    try {
      const next = await stashTag({ id: entry.id, ...change });
      stashStore.upsert([next]);
      if (change.add?.length) stashStore.markNewTags(entry.id, change.add);
    } catch (err) {
      toasts.push({ kind: 'stash', note: { what: 'error', message: String(err) } });
    }
  }

  /**
   * ⌃T (stage 03) with the drawer open (D18): the ⇧-selection, else the card
   * under the keyboard ring, else the active tab; nothing while the stash has
   * the keys. With the drawer closed: stage 03's own put-away of the active document.
   */
  function putAwayByKey(activeOnly: () => void): void {
    const targets = drawerHandle?.putAwayTargets();
    if (targets === null) return;
    if (targets === undefined) {
      activeOnly();
      return;
    }
    void putAway(targets);
  }

  /** ⌃S (D18): toggles the stash from anywhere — from a closed drawer, both open. */
  const onWindowCtrlS = ctrlSHandler(() => drawerHandle?.toggleStash());

  /** The window widened for the stash (D15) — put back when it closes. */
  let widened: WidenMemo | null = null;
  $effect(() => {
    const open = stashStore.state.open;
    untrack(() => {
      if (open) {
        void widenForStash().then((memo) => {
          if (!memo) return;
          // Closed again before the widen landed: put it straight back.
          if (!stashStore.state.open) {
            void restoreWindow(memo);
            return;
          }
          widened = memo;
          quietStashToast({ what: 'widened' });
        });
      } else if (widened) {
        const memo = widened;
        widened = null;
        void restoreWindow(memo);
      }
    });
  });
```

- [ ] **Step 3: Listeners, keys and menu (in `onMount`)**

Next to `const unlistenTabsArrive = onTabsArrive(…);` add:

```ts
    // Stash stage 04 (D9): another window asks for a tab this one holds. The
    // plan-05 move, run here where its dirty checks live; no «Перенесено»
    // toast — the human is in the other window, which announces the arrival.
    const unlistenTabPull = onTabPull(({ path, target }) => {
      void tabSourcesReady
        .then(async () => {
          const tab = tabs.findByPath(path);
          if (tab) await tabs.moveTabs([tab.id], { kind: 'window', label: target });
        })
        .catch((err: unknown) => console.error('Failed to hand a tab to another window:', err));
    });
    const unlistenStashChanged = onStashChanged(() => stashStore.changed());
```

In the cleanup, next to `unlistenTabsArrive.then((fn) => fn());` add:

```ts
      unlistenTabPull.then((fn) => fn());
      unlistenStashChanged.then((fn) => fn());
```

Find stage 03's ⌃T registration (`window.addEventListener('keydown', <⌃T handler>, true);`, after `onWindowCtrlTab`). Change the callback stage 03 passes to its handler factory from `<existing callback>` to `() => putAwayByKey(<existing callback>)`, and right after its `addEventListener` line add:

```ts
    window.addEventListener('keydown', onWindowCtrlS, true);
```

and in the cleanup, after the ⌃T `removeEventListener`, add `window.removeEventListener('keydown', onWindowCtrlS, true);`.

In the menu switch, after the `case 'toggle_drawer':` branch add:

```ts
        case 'toggle_stash':
          drawerHandle?.toggleStash();
          break;
```

- [ ] **Step 4: Markup**

`<main data-zoom={zoom.level} class:carousel-on={carouselOn}>` becomes (D17 — the same veil for both):

```svelte
<main data-zoom={zoom.level} class:carousel-on={carouselOn || stashStore.state.open}>
```

In `<TabDrawer …>`, after `onrenumber={renumber}` add:

```svelte
  stash={stashStore}
  onputaway={(ids) => void putAway(ids)}
  onstashopen={(entry, before) => void openStashEntry(entry, before)}
  onstashremove={(entry) => void removeStashEntry(entry)}
  onstashtag={(entry, change) => void tagStashEntry(entry, change)}
```

In `<ToastStack …>` add `right={stashStore.state.open ? stashStore.width + 16 : undefined}`.

- [ ] **Step 5: Gates**

Run: `npm run check` → 0 errors.
Run: `npx vitest run --dir src` → baseline + every test added in Tasks 1–21, 0 failed.
Run: `CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result"` → baseline + 7, 0 failed.

- [ ] **Step 6: Commit**

```bash
git add src/App.svelte
git commit -m "$(cat <<'EOF'
feat(stash): wire the stash drawer into the window — store, put-away, open/pull, ⌃S, widen

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/App.svelte
```

---

## Task 23: Browser QA against the mockup at three widths (Playwright on a private Vite)

**Files:**
- Create (outside the repo): `$QA/vite.qa.config.mts`, `$QA/stash-qa.mjs`
- Create: `docs/superpowers/plans/night-shots/stash/stash04-*.png`

The app and the mockup render in one Chrome from one data set: the script extracts `STASH0`, `SAMPLE`, `WIN_PROJECT`, `WT`, `REPORT_MD` from `stash-drawers.html` and feeds the app through a stubbed `__TAURI_INTERNALS__` (the tabs plans' pattern). Never the shared MCP browser; never a second Vite on the shared dep cache (CLAUDE.md).

- [ ] **Step 1: A private Vite**

```bash
QA="${CLAUDE_JOB_DIR:-/tmp}/stash04"; mkdir -p "$QA" docs/superpowers/plans/night-shots/stash
lsof -ti:1457 && echo "port 1457 busy — pick another free port and use it in both files" || true
cat > "$QA/vite.qa.config.mts" <<EOF
import { mergeConfig } from '$PWD/node_modules/vite/dist/node/index.js';
import base from '$PWD/vite.config.ts';

export default mergeConfig(base, {
  root: '$PWD',
  cacheDir: '$QA/vite-cache-qa',
  server: { port: 1457, strictPort: true, hmr: false },
});
EOF
```

Start it with the Bash tool's `run_in_background`: `npx vite --config "$QA/vite.qa.config.mts"`. Record its PID: `lsof -ti:1457 > "$QA/vite-qa.pid"`. Wait until `curl -s -o /dev/null -w "%{http_code}" http://localhost:1457/` prints `200`.

- [ ] **Step 2: The script**

`$QA/stash-qa.mjs` (run from the repo root):

```js
// Stash drawer vs the approved mockup, one Chrome, one data set, three widths.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const REPO = process.cwd();
const require = createRequire(`${REPO}/package.json`);
const { chromium } = require('playwright');

const TMP = `${process.env.CLAUDE_JOB_DIR ?? '/tmp'}/stash04`;
const SHOTS = `${REPO}/docs/superpowers/plans/night-shots/stash`;
const BASE = 'http://localhost:1457';
const MOCKUP = `${REPO}/docs/investigations/2026-09-26-stash-mockup/stash-drawers.html`;
mkdirSync(SHOTS, { recursive: true });

// --- The mockup's own data ---
const html = readFileSync(MOCKUP, 'utf8');
const SCOPE = {};
function grab(name) {
  const m = new RegExp(
    `const ${name} =\\s*(\\[\\n[\\s\\S]*?\\n\\]|\`(?:\\\\[\\s\\S]|[^\\\\\`])*\`|'[^']*'|\\d+);`
  ).exec(html);
  if (!m) throw new Error(`mockup constant ${name} not found`);
  const keys = Object.keys(SCOPE);
  return new Function(...keys, `return ${m[1]}`)(...keys.map((k) => SCOPE[k]));
}
SCOPE.WIN_PROJECT = grab('WIN_PROJECT');
SCOPE.WT = grab('WT');
SCOPE.REPORT_MD = grab('REPORT_MD');
const TODAY_MIN = grab('TODAY_MIN');
const STASH0 = grab('STASH0');
const SAMPLE = grab('SAMPLE');

const NOW = new Date(2026, 8, 26, Math.floor(TODAY_MIN / 60), TODAY_MIN % 60).getTime();
const ago = (min) => NOW - min * 60_000;
const notePath = (id) => `/Users/qa/Documents/couplet-dev/${id}.md`;
const filePath = (proj, dir, name) => `/qa04/${proj}/${dir ?? ''}${name}`;
function titleOf(md) {
  for (const l of md.split('\n')) {
    if (l.startsWith('```')) continue;
    const p = l.replace(/^#{1,6}\s+/, '').replace(/^- \[( |x)\] /, '').replace(/^(?:-|\d+\.|>) /, '').replace(/\*\*|`|\*/g, '').trim();
    if (p) return p;
  }
  return null;
}
const ENTRIES = STASH0.map((it) => ({
  id: it.id,
  kind: it.kind,
  path: it.kind === 'note' ? notePath(it.id) : filePath(it.repo, it.dir, it.name),
  title: it.kind === 'note' ? titleOf(it.md) : it.name,
  repo: it.repo,
  branch: it.kind === 'file' ? it.br : null,
  tags: it.tags,
  createdAt: ago(it.edited + 60),
  modifiedAt: ago(it.edited),
  stashedAt: it.away == null ? null : ago(it.away),
  openedAt: ago(it.opened),
  deletedAt: null,
  caret: 0,
  topLine: 1,
  preview: it.md.slice(0, 400),
}));
const byNote = Object.fromEntries(STASH0.filter((s) => s.kind === 'note').map((s) => [s.id, s]));
const TABS = SAMPLE.map((s, i) => ({
  tabId: String(s.id),
  path: s.noteId ? notePath(s.noteId) : filePath(s.proj, s.dir, s.name),
  content: null,
  cursor: 0,
  topLine: 1,
  openedAt: (i + 1) * 1000,
  viewedAt: (i + 1) * 1000,
  unviewed: false,
}));
const FILES = Object.fromEntries([
  ...SAMPLE.map((s) => [s.noteId ? notePath(s.noteId) : filePath(s.proj, s.dir, s.name), s.noteId ? byNote[s.noteId].md : s.md]),
  ...STASH0.map((it) => [it.kind === 'note' ? notePath(it.id) : filePath(it.repo, it.dir, it.name), it.md]),
]);
const GIT = Object.fromEntries(SAMPLE.filter((s) => s.proj).map((s) => [filePath(s.proj, s.dir, s.name), { project: s.proj, branch: s.br }]));
// n9 is open in the mockup's off-screen window #19.
const HOLDERS = { [notePath('n9')]: { label: 'editor-19', number: 19 } };
const TODAY0 = new Date(2026, 8, 26).getTime();
const COUNTS = { total: ENTRIES.length, stashedToday: ENTRIES.filter((e) => e.stashedAt !== null && e.stashedAt >= TODAY0).length, deleted: 3 };

function stub(theme, width) {
  return `(() => {
    localStorage.setItem('md-mini:theme', ${JSON.stringify(JSON.stringify(theme))});
    localStorage.setItem('md-mini:themeSystem', 'false');
    localStorage.setItem('md-mini:themesNudgeSeen', '1');
    const files = ${JSON.stringify(FILES)};
    const git = ${JSON.stringify(GIT)};
    const entries = ${JSON.stringify(ENTRIES)};
    const holders = ${JSON.stringify(HOLDERS)};
    const callbacks = new Map();
    let nextId = 1;
    window.__calls = [];
    window.__listeners = {};
    window.__emit = (event, payload) => {
      for (const id of window.__listeners[event] ?? []) callbacks.get(id)?.({ event, id: 0, payload });
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: (cb) => { const id = nextId++; callbacks.set(id, cb); return id; },
      unregisterCallback: (id) => callbacks.delete(id),
      convertFileSrc: (p) => p,
      invoke: async (cmd, args) => {
        window.__calls.push([cmd, JSON.parse(JSON.stringify(args ?? {}))]);
        if (cmd === 'plugin:event|listen') { (window.__listeners[args.event] ??= []).push(args.handler); return args.handler; }
        const w = window.innerWidth * 2, h = window.innerHeight * 2;
        switch (cmd) {
          case 'resolved_language': return 'ru';
          case 'get_window_init': return { number: 22, tabs: ${JSON.stringify(TABS)}, activeTabId: '2' };
          case 'file_exists': return args.path in files;
          case 'read_file': if (args.path in files) return files[args.path]; throw new Error('ENOENT: ' + args.path);
          case 'write_file': files[args.path] = args.content; return null;
          case 'tab_git_info': return args.paths.map((p) => git[p] ?? null);
          case 'comment_threads': return [];
          case 'tab_open': return { kind: 'created', tabId: 'n' + nextId++, path: args.path ?? null };
          case 'tab_owner': return { kind: 'none' };
          case 'ai_pull_pending': return [];
          case 'recent_files_list': return { files: [], generation: 0 };
          case 'pending_session_count': return 0;
          case 'ai_nudge_pending': return false;
          case 'stash_list': return { entries, total: entries.length, nextCursor: null };
          case 'stash_counts': return ${JSON.stringify(COUNTS)};
          case 'stash_entry_for_path': return entries.find((e) => e.path === args.path) ?? null;
          case 'tab_holders': return args.paths.map((p) => holders[p] ?? null);
          case 'window_repo': return ${JSON.stringify(SCOPE.WIN_PROJECT)};
          case 'tab_request_move': return { kind: 'not-open' };
          case 'stash_put_away': return args.paths.map((p) => {
            const found = entries.find((e) => e.path === p);
            return { entry: found ?? { ...entries[0], id: 'new-' + p, kind: 'file', path: p, title: p.split('/').pop(), tags: [], stashedAt: Date.now() }, created: !found };
          });
          case 'plugin:window|scale_factor': return 2;
          case 'plugin:window|is_fullscreen': return false;
          case 'plugin:window|inner_size': return { width: w, height: h };
          case 'plugin:window|outer_size': return { width: w, height: h + 56 };
          case 'plugin:window|outer_position': return { x: 200, y: 100 };
          case 'plugin:window|current_monitor': return { name: 'QA', scaleFactor: 2, position: { x: 0, y: 0 }, size: { width: 2880, height: 1800 }, workArea: { position: { x: 0, y: 50 }, size: { width: 2880, height: 1700 } } };
          default: return null;
        }
      },
    };
  })();`;
}

const browser = await chromium.launch({ channel: 'chrome' });
const results = {};
const errors = [];
const check = (name, ok, detail) => { results[name] = ok ? true : { ok: false, detail }; };
const wait = (page, ms) => page.waitForTimeout(ms);
const WIDTHS = { wide: 1180, narrow: 720, xnarrow: 560 };

async function appPage(theme, width) {
  const page = await browser.newPage({ viewport: { width, height: 760 } });
  page.on('pageerror', (e) => errors.push(`app pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`app console: ${m.text()}`); });
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(stub(theme, width));
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.cm-content');
  await page.waitForSelector('.tab-drawer .notch');
  await wait(page, 800);
  await page.evaluate(() => window.__emit('menu-event', 'toggle_drawer'));
  await wait(page, 400);
  await page.keyboard.press('ArrowRight');
  await wait(page, 700);
  return page;
}

async function mockPage(theme, widthKey) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 860 } });
  await page.goto(`file://${MOCKUP}?theme=${theme}${widthKey === 'wide' ? '' : `&width=${widthKey}`}`);
  await wait(page, 600);
  await page.click('#demoToggle');
  await wait(page, 400);
  await page.click('#demoStash');
  await wait(page, 900);
  return page;
}

const stashTitles = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()));
const widthOf = (page, sel) => page.$eval(sel, (e) => Math.round(e.getBoundingClientRect().width));

for (const theme of ['aurora-light', 'aurora-dark', 'light', 'dark']) {
  for (const [key, width] of Object.entries(WIDTHS)) {
    if (theme !== 'aurora-light' && key !== 'wide') continue;
    const app = await appPage(theme, width);
    const mock = await mockPage(theme, key);
    const tag = `${key}-${theme}`;

    if (key === 'xnarrow') {
      const sizes = await app.evaluate(() => window.__calls.filter(([c]) => c === 'plugin:window|set_size').map(([, a]) => a));
      check(`${tag}: widened to 680`, JSON.stringify(sizes).includes('680'), sizes);
      await app.setViewportSize({ width: 680, height: 760 }); // what the widened window shows
      await wait(app, 500);
    }

    const expected = { wide: [420, 400], narrow: [340, 340], xnarrow: [320, 320] }[key];
    check(`${tag}: widths`, (await widthOf(app, '.drawer-wrap')) === expected[0] && (await widthOf(app, '.stash-wrap')) === expected[1], [
      await widthOf(app, '.drawer-wrap'),
      await widthOf(app, '.stash-wrap'),
    ]);
    check(`${tag}: compact only when squeezed`, (await app.$('.tab-drawer.compact')) !== null === (key !== 'wide'));
    check(`${tag}: page veiled`, (await app.$eval('main', (m) => getComputedStyle(m).filter)).includes('blur'));
    check(`${tag}: stash has the keys`, (await app.$('.stash-drawer.focused')) !== null);
    check(`${tag}: rim lit`, (await app.$eval('.stash-drawer.focused', (e) => getComputedStyle(e, '::after').opacity)) === '1');

    const appTitles = await stashTitles(app, '.stash-drawer [data-stash-id] .card-name');
    const mockTitles = await stashTitles(mock, '#stCards .card .card-name');
    check(`${tag}: same cards in the same order`, JSON.stringify(appTitles) === JSON.stringify(mockTitles), { appTitles, mockTitles });

    await app.screenshot({ path: `${SHOTS}/stash04-${tag}-app.png` });
    await (await mock.$('#win1')).screenshot({ path: `${SHOTS}/stash04-${tag}-mock.png` });

    if (theme === 'aurora-light' && key === 'wide') {
      // Behaviour, once.
      await app.click('.stash-drawer .fchip-x');
      await wait(app, 400);
      check('chip removed: n9 shows «открыта в #19»', ((await app.$eval('[data-stash-id="n9"] .open-mark', (e) => e.textContent)) ?? '').includes('#19'));
      await app.keyboard.type('сн');
      await wait(app, 300);
      check('typing filters the stash', (await app.$eval('.stash-drawer .s-q', (e) => e.textContent)) === 'сн');
      await app.keyboard.press('Escape');
      await app.keyboard.press('Escape');
      await wait(app, 500);
      check('Esc Esc: the stash closes alone', (await app.$('.stash-wrap.open')) === null && (await app.$('.tab-drawer.open')) !== null);
      await app.keyboard.press('Control+s');
      await wait(app, 700);
      check('⌃S opens it again', (await app.$('.stash-wrap.open')) !== null);
      // A tab card onto the drop zone.
      const cardBox = await app.locator('.tab-list [role="tab"]').nth(1).boundingBox();
      const barBox = await app.locator('.stash-bar').boundingBox();
      await app.mouse.move(cardBox.x + 40, cardBox.y + 20);
      await app.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await app.mouse.move(cardBox.x + 40, cardBox.y + 20 + ((barBox.y + 20 - cardBox.y - 20) * i) / 10);
        await wait(app, 16);
      }
      await wait(app, 200);
      check('drop zone is up', (await app.$('.stash-bar.dropmode.hot')) !== null);
      await app.screenshot({ path: `${SHOTS}/stash04-dropzone-app.png` });
      await app.mouse.up();
      await wait(app, 600);
      const put = await app.evaluate(() => window.__calls.filter(([c]) => c === 'stash_put_away'));
      check('put away through stash_put_away', put.length === 1, put);
      // A stash card onto the tab list.
      const stashBox = await app.locator('.stash-drawer [data-stash-id]').first().boundingBox();
      const listBox = await app.locator('.tab-list').boundingBox();
      await app.mouse.move(stashBox.x + 40, stashBox.y + 20);
      await app.mouse.down();
      for (let i = 1; i <= 12; i++) {
        await app.mouse.move(stashBox.x + 40 + ((listBox.x + 100 - stashBox.x - 40) * i) / 12, stashBox.y + 20);
        await wait(app, 16);
      }
      await app.mouse.up();
      await wait(app, 600);
      const asked = await app.evaluate(() => window.__calls.filter(([c]) => c === 'tab_request_move'));
      check('stash → tabs asks tab_request_move', asked.length === 1, asked);
      // The colour token follows the link colour.
      check('--color-stash = --color-link', await app.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        return s.getPropertyValue('--color-stash').trim() !== '' && s.getPropertyValue('--stash-tint').trim() !== '';
      }));
    }

    if (key === 'narrow' && theme === 'aurora-light') {
      // No carousel between squeezed drawers.
      const cardBox = await app.locator('.tab-list [role="tab"]').nth(1).boundingBox();
      await app.mouse.move(cardBox.x + 40, cardBox.y + 20);
      await app.mouse.down();
      await app.mouse.move(width / 2, 300, { steps: 10 });
      await wait(app, 500);
      check('narrow: no carousel in the gap', (await app.$('.carousel')) === null);
      await app.keyboard.press('Escape');
      await app.mouse.up();
    }

    await app.close();
    await mock.close();
  }
}

await browser.close();
writeFileSync(`${TMP}/stash-qa-results.json`, JSON.stringify({ results, errors }, null, 2));
console.log(JSON.stringify({ results, errors }, null, 2));
```

(Check the theme storage key in `src/lib/stores.svelte.ts` before running: if it is no longer `md-mini:theme` after the rename, use the current one in `stub`.)

- [ ] **Step 3: Run it**

Run: `node "${CLAUDE_JOB_DIR:-/tmp}/stash04/stash-qa.mjs"`
Expected: every `results` entry `true`; `errors` empty. A `console.error` the app logs by design for a stubbed IPC (for example a stage-03 call the stub answers `null`) is listed with its text in the night report, not hidden. Differences you see between the `-app.png` and `-mock.png` pairs are listed for the owner, not "fixed" by eye (memory: show every version to the owner before judging it).

- [ ] **Step 4: Stop your Vite and commit the shots**

```bash
kill "$(cat "${CLAUDE_JOB_DIR:-/tmp}/stash04/vite-qa.pid")"
git add docs/superpowers/plans/night-shots/stash/stash04-*.png
git commit -m "$(cat <<'EOF'
docs(stash): stage 04 browser QA — app vs mockup at three widths

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- docs/superpowers/plans/night-shots/stash/stash04-*.png
```

---

## Task 24: Live QA in the dev app — auto-widen, drags, the pull between windows

**Files:**
- Create: `docs/superpowers/plans/night-shots/stash/stash04-dev-*.png`

**Safety — follow verbatim.** Only `npm run dev:app` (dev identity `couplet-dev`, notes in `~/Documents/couplet-dev/`, data in `~/Library/Application Support/couplet-dev/`). CLI only with `--socket /tmp/couplet-dev_cmd.sock`. No System Events, no `osascript`, no OS keystrokes: keys are `KeyboardEvent`s with `code`, dispatched on `document.body` by `mcp__tauri__webview_execute_js`; async IPC by fire-then-read (CLAUDE.md «MCP dev bridge»). Kill only PIDs you recorded.

- [ ] **Step 1: Scratch project and the app**

```bash
QA="${CLAUDE_JOB_DIR:-/tmp}/stash04"
mkdir -p /tmp/stash04/p1/.git /tmp/stash04/p2
echo "ref: refs/heads/main" > /tmp/stash04/p1/.git/HEAD
for f in a b c; do printf "# %s\n\nline two\nline three\n" "$f" > /tmp/stash04/p1/$f.md; done
printf "# e\n\nother project\n" > /tmp/stash04/p2/e.md
```

Start with `run_in_background`:

```bash
CARGO_TARGET_DIR=~/.cargo/stash-impl-target npm run dev:app -- --features mcp-bridge \
  --config '{"app":{"windows":[{"title":"stash-04 · local"}]}}'
```

Record the app PID (`ps -o pid,lstart,command | grep "debug/md-mini"` — started after your launch) to `$QA/app.pid`; wait for `test -S /tmp/couplet-dev_cmd.sock`. Connect `mcp__tauri__driver_session`; check `mcp__tauri__ipc_get_backend_state` reports this worktree as `cwd`. `BIN=~/.cargo/stash-impl-target/debug/md-mini`, `SOCK=/tmp/couplet-dev_cmd.sock`.

Set-up: `$BIN ai open /tmp/stash04/p1/a.md /tmp/stash04/p1/b.md /tmp/stash04/p1/c.md -t <main's #> --socket $SOCK` (window A, bound to `p1`); `CLAUDECODE=1 $BIN ai open /tmp/stash04/p2/e.md --socket $SOCK` (window B).

Helpers for the evals (paste into each call as needed):

```js
const key = (code, key, mods = {}) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true, ...mods }));
const ptr = (el, type, x, y, buttons = 1) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons, button: 0, pointerId: 1 }));
```

- [ ] **Step 2: Scenarios**

1. **⌃S from the editor.** In A: `key('KeyS', 's', { ctrlKey: true })`. **Expected:** `.tab-drawer.open` and `.stash-wrap.open`; `.stash-drawer.focused`; the chip reads `p1`; `getComputedStyle(document.querySelector('main')).filter` contains `blur` → `mcp__tauri__webview_screenshot` → `stash04-dev-01-both-open.png`. `key('KeyS', 's', { ctrlKey: true })` again → the stash closes, the tabs drawer stays.
2. **Put away by drag.** Open the drawers with ⌃S (⌘J is a native menu accelerator and synthetic events never reach it), then `key('ArrowLeft','ArrowLeft')` to give the tabs drawer the keys. Drag `b.md`'s card onto `.stash-bar`: `ptr(card,'pointerdown',…)`, then `ptr(window,'pointermove',…)` in 10 steps to the bar's centre (`getBoundingClientRect()`), `ptr(window,'pointerup',…,0)`. **Expected:** the tab leaves A; with the stash open the card arrives on top; the toast «b.md → тайник · отложено»; fire-then-read `window.__TAURI_INTERNALS__.invoke('stash_list', {}).then(r => window.__probe = r)` then read `window.__probe.entries.map(e => e.path)` → contains `/tmp/stash04/p1/b.md` (the registry spelling — `/private/tmp/…` on macOS) → `stash04-dev-02-put-away.png`.
3. **Dedup pulse.** Drag `b.md`'s stash card onto A's tab list (it opens there), then put it away again the same way. **Expected:** toast «… запись уже была — вторая не создана»; the card pulses; `stash_list` still has one entry for that path.
4. **The pull between windows.** In A, open the stash, remove the chip (`.fchip-x` click), find `e.md`'s card: `.open-mark` reads «открыт в #<B>». Click it. **Expected:** `e.md` arrives in A as the active tab, toast «e.md открыт вкладкой · переехал из #<B>»; `$BIN ai ls --json --socket $SOCK` lists `e.md` under A; B has closed if `e.md` was its last tab → `stash04-dev-03-pulled.png`.
5. **Auto-widen.** Resize A to 560×700 logical (`mcp__tauri__manage_window` resize; if that tool has no resize action, fire `window.__TAURI_INTERNALS__.invoke('plugin:window|set_size', { label: '<A label>', value: { Logical: { width: 560, height: 700 } } })`). ⌃S. **Expected:** `window.innerWidth` → 680 (at 100 % zoom); toast «Окно раздвинулось, чтобы тайник встал рядом · вернётся, когда тайник закроется»; both drawers 320 px, compact cards → `stash04-dev-04-widened.png`. ⌃S → `window.innerWidth` back to 560. Then move A so its right edge touches the screen's right edge, ⌃S again → the window moved left, not off-screen; ⌃S → back in place. Repeat with the window resized by hand (manage_window) while the stash is open → closing does **not** snap it back.
6. **Fullscreen is left alone.** Put A in fullscreen (`plugin:window|set_fullscreen` with `{ value: true }` by fire-then-read) at a narrow size — ⌃S: nothing widens; leave fullscreen.
7. **Keys.** With both open: → / ← move the rim (`.stash-drawer.focused` ↔ `#tab-drawer.focused`); typing `#pro` in the stash filters by tag; Esc clears, Esc closes the stash alone; Esc in the tabs drawer closes both.
8. **For the owner's eye:** both drawers open, wide window, in each of `light`, `dark`, `aurora-light`, `aurora-dark` → `stash04-dev-theme-<theme>.png`. Switch themes only through the Theme menu with the guarded AX-by-pid helper from tabs plan 03 Task 16 (it checks the pid's executable is `~/.cargo/stash-impl-target/debug/md-mini`); confirm `document.documentElement.dataset.theme` by eval after each switch. Without that helper, skip this step and say so in the night report — Task 23 already has the four themes side by side with the mockup.
9. **Quit and clean up.** Quit through the guarded AX helper (or `kill "$(cat "$QA/app.pid")"` — only that PID). Leave `~/Documents/couplet-dev/` as it is.

- [ ] **Step 3: Commit the shots**

```bash
git add docs/superpowers/plans/night-shots/stash/stash04-dev-*.png
git commit -m "$(cat <<'EOF'
docs(stash): stage 04 live QA in the dev app — widen, drags, pull between windows

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- docs/superpowers/plans/night-shots/stash/stash04-dev-*.png
```

---

## Task 25: Docs, final gates, review, night report

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/plans/2026-09-27-stash-night-report.md` (create the file if stage 01–03 did not)

- [ ] **Step 1: `CLAUDE.md`**

In «Architecture», under `src/` → `lib/`, add after the `lib/tabs/` block:

```markdown
  lib/stash/            # The stash (тайник). Stage 04: the drawer
    stash-store.svelte.ts # Per-window store: entries (+ search index), counts, holders, window repo, pulse marks, the drawer-pair state
    stash-state.ts      # Pure: open/close/focus/query/sort/repo chip; stash key routing; pulse diff
    stash-view.ts / stash-query.ts # Pure: visible rows (open-here hidden), sorts changed/opened/kind, «отложено …»; #tag / phrase / text
    drawer-width.ts     # Pure: NARROW_AT 960 / MIN_BOTH 680 widths, carousel band, widen plan
    window-widen.ts     # Widen a narrow window for the stash and restore it (setSize/setPosition, work area)
    put-away.ts / open-from-stash.ts # Tabs → stash (one stash_put_away, then closeTabs); stash → tabs (tab_request_move: here / pull / open)
    StashDrawer.svelte / StashCard.svelte / StashBar.svelte # Rendered inside TabDrawer's root; TabDrawer owns keys, focus trap and drags
```

In «Gotchas», add:

```markdown
- **The stash drawer lives inside `TabDrawer`'s `display: contents` root, on purpose.** One focus trap (`insideDrawer`), one capture-phase `keydown` listener, one drag machine, one scrim: `TabDrawer` routes keys to the stash through `StashDrawer`'s handle (`key(e)`) and runs stash-card drags itself. A second window listener would fight the first over every key, and two drag machines could not hand a card across. Focus between the drawers is store state (`stash-state.ts`); DOM focus follows it, routing never reads the DOM.
- **Opening a stash entry held by another window is a pull, not a move from here.** `tab_move` is driven by the source window (its dirty checks, caret, agent inbox), so `tab_request_move` only emits `tab-pull` to the holder, which runs its own `moveTabs` to the requester. The requester watches `PULL_WAIT_MS` for the tab; a holder that refuses (unsaved text) shows its own toast there, and the requester offers «Перейти».
- **`window-widen.ts` needs `core:window:allow-set-size` and `allow-set-position`** — the getters are in `core:window:default`, the setters are not, and a rejected setter is silent (like the zoom before it). It restores size and place only while the window is still exactly as widened, so a resize the human made meanwhile survives.
- **`--color-stash` is a theme token set to `var(--color-link)` in every theme**, and `--stash-tint/-line/-soft` are mixed from it in `styles/stash.css`. Tune a theme by changing its `--color-stash` value, never in a component.
```

- [ ] **Step 2: Final gates**

```bash
npx vitest run --dir src 2>&1 | grep -E "Test Files|Tests "
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result"
CARGO_TARGET_DIR=~/.cargo/stash-impl-target cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "generated [0-9]+ warning"
npm run check 2>&1 | tail -3
CARGO_TARGET_DIR=~/.cargo/stash-impl-target npm run check:x86
```

Expected: vitest = baseline + the new tests, 0 failed; cargo = baseline + 7 passed, 0 failed; clippy = baseline; check 0 errors; x86 builds.

- [ ] **Step 3: Code review**

Dispatch the `code-reviewer` agent (model opus) over `git diff <stage-03 last commit>..HEAD` with this brief: the plan file, the roadmap contracts, the data-safety rules (no user text deleted — `stash_delete` must refuse notes and never touch the file), the CLAUDE.md drawer gotchas (stacking, Q5 key ownership, capture handlers, passive wheel, `animate:` on components), and «no `any`, runes only». Fix every finding in its own commit (`fix(stash): …`), re-run Step 2.

- [ ] **Step 4: Night report**

Add a section `## Stage 04 — дровер тайника` to `docs/superpowers/plans/2026-09-27-stash-night-report.md`: what was built (one line per task), the QA results table from `stash-qa-results.json`, the shots (paths), the substitutions from `$QA/substitutions.md`, that es/de/fr/zh carry English stash strings until translated, and the Known gaps below. Commit:

```bash
git add CLAUDE.md docs/superpowers/plans/2026-09-27-stash-night-report.md
git commit -m "$(cat <<'EOF'
docs(stash): stage 04 — CLAUDE.md architecture and gotchas, night report

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- CLAUDE.md docs/superpowers/plans/2026-09-27-stash-night-report.md
```

Push `feat/stash` as the implementer prompt says.

---

## Spec coverage (self-review)

| Spec «Интерфейс» item | Where |
|---|---|
| Bottom area: «Тайник» + «19 · отложено сегодня 6» | Task 16 (`StashBar`), Task 18 (render, counts refresh on open) |
| Drop zone «Отложить в тайник · N вкладок» while dragging | Task 16 (`dropmode`), Task 20 (drag → `onputaway`) |
| Right drawer, mirror of the tabs drawer, stash colour from the link colour | Tasks 1, 17, 18 |
| One list, no sections; sorts ⌘L/⌘R/⌘U, default «изменение» | Tasks 5, 6, 17 |
| Card: kind icon, title, bright «отложено …», repo/branch/path, preview, tags (repo dashed) | Tasks 5, 15 |
| «убрать из тайника» for files (note «удалить» — stage 06) | Tasks 9, 15, 22 |
| Both open: page blurred and dimmed like the carousel | Tasks 18 (scrim), 22 (`main` blur) |
| Open here hidden; stash → tabs opens, tabs → stash puts away; «открыта в #N» and moving from that window | Tasks 5, 8, 12, 17, 20, 22 |
| Never overlap: > 960 normal widths, 680–960 halves + compact, < 680 auto-widen with toast; fullscreen untouched | Tasks 3, 13, 18, 22 |
| Focus ←/→, glowing rim only, no dimming | Tasks 17, 19 |
| Keys: ⌃S, ←/→, typing, Esc (query → close; tabs closes both), ⌘L/⌘R/⌘U | Tasks 6, 14, 17, 19, 22 |
| ⌃S as a page handler, menu item without key | Tasks 10, 14, 22 |
| Tags: repo auto-filter chip (removable, re-add), `#tag` filter | Tasks 4, 6, 11, 17 |
| Dedup: raise and pulse, merge tags | Tasks 6, 11, 22 |
| Trash view, FTS search, `/stash` slash command | stages 06, 05; `/stash` — see Known gaps |

## Known gaps

1. **Broken file refs** («файл не найден», «найти» / «убрать») are not drawn: opening a missing file shows the existing `open-error` toast. The spec lists it under «Модель»; it needs an existence probe per entry (stage 02 could report it in `StashEntry`).
2. **`/stash` in the slash menu** (spec «Клавиатура») is not built here — it belongs with the notes (stage 03) or a follow-up.
3. **«открыта в #N» can be stale** until the next list reload: windows moving tabs among themselves do not emit `stash-changed`. The stash reloads on every open and on every stash write.
4. **A pull the holder refuses** (unsaved text there) is reported only after `PULL_WAIT_MS` with «Перейти»; the reason is shown in the holder window, not here.
5. **Undo history does not cross** a pull (plan 05's rule for any move).
6. **Case is not folded** in the open-here check (`path_norm`'s known gap): `A.md` and `a.md` on APFS count as two paths.
7. **Stash drawer chrome CSS repeats the tabs drawer's** (scoped styles cannot be shared): headers, sorts, search line. Keep them in step; a shared stylesheet is a refactor for later.
8. **Toast position:** the app's bottom-right stack shifted left of the stash (D19), not the mockup's centred toast.

## Reuse vs duplication (for the reviewer)

- **Reused as is:** `drawer-filter.ts` (`matchEntry`, `indexText`, `highlight`, `hitSnippet`), `drawer-preview.ts` (`previewLines`), `drawer-geometry.ts` (`pastThreshold`, `dropBefore`, `moveIds`), `drawer-state.ts` (`EXPAND_MS`, `KeyLike`, the tabs Esc/selection reducer), `carousel.ts` (`wantsCarousel`, fed a band), `TabDrawer`'s `track`, ghost, drop indicator, focus trap and capture listener, `controller.closeTabs` / `openPath` / `moveTabs` / `reorder` / `findByPath`, plan 05's `tab_move` (through `tab-pull`), `owner_for`, `git_info::dir_name`, `routing::bind_missing_projects`, `quietToast`, `tabs.drawer.*` strings (sort label, search count, reset, empty, «в тексте:», tab count plural).
- **Duplicated on purpose:** the card and drawer-chrome CSS (scoped styles), the `arrive`/`collapse` transitions mirrored to the right, a 5-line `stashKbTarget`/`moveStashKb` (the tabs versions take a `DrawerState`), and the key-action switch shape of `drawerKeyAction`.

