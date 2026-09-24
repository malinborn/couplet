# Tabs 05 — Window Carousel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move tabs between windows through the window carousel: drag a card (or a ⇧-selection) out of the drawer onto the page → the page blurs and a vertical carousel of the other windows appears («+ Новое окно» first, then most recently focused); drop on a thumbnail moves the tab(s) there, on «+ Новое окно» into a new window; ⌘M / «В окно…» does the same from the keyboard. Everything moves with a tab — untitled text, stamps, caret, quick-look state, parked agent questions and the agents' pending requests — in one atomic Rust step.

**Architecture:** Rust owns the move: one command `tab_move` does, under the single `OpenFiles` lock, the registry move (source tombstoned, target claims), the re-labelling of every agent request for the moved files, and the hand-over to the target (a `tabs-arrive` event for a mounted window, the pending payload for one built for the move); the session snapshot follows after the lock. The source frontend uses the controller's check → prepare → hand over → swap order, with the one `await` (the IPC) after the swap, so nothing typed can reach a leaving tab; the target frontend inserts what arrives and shows the first tab. The carousel is a presentational component fed by a sibling IPC (`tab_carousel_windows`) and driven by the drawer's existing pointer gesture plus a keyboard path (listbox).

**Tech Stack:** Tauri 2 (Rust), Svelte 5 runes, TypeScript strict, CodeMirror 6, vitest (+ jsdom for the two components), cargo test, Playwright (`channel: 'chrome'`) for QA. No new dependencies.

**Sources of truth:** visuals — the approved mockup `docs/investigations/2026-09-24-tabs-mockup/drawer-carousel.html` (Max: «великолепно, так и сделаем»; shots `docs/superpowers/plans/night-shots/tabs05-carousel-*.png`), mockup wins on visuals; behaviour — spec `docs/superpowers/specs/2026-09-24-tabs-design.md` §6 «Пространственные операции» and `tabs-questions.md` Q2 (resolved: carousel), spec wins on behaviour. Roadmap row 05 (`2026-09-24-tabs-00-roadmap.md`). **Naming:** the CLI stays `mdmini`; nothing here is released — **no release steps, nothing under `/Applications`.**

---

## Working rules (read before Task 1)

- **Worktree:** `/Users/maximkovalevskij/playground/md-mini/.claude/worktrees/tabs-impl`, branch `feat/tabs`. Run every command from there. Never `git stash`, `checkout`, `reset` or `restore`; `git add` explicit paths only and commit with the same pathspec (`git commit -m … -- <paths>`).
- **Commit trailer:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Cargo:** every cargo command is prefixed with `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target`. Tests: `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target cargo test --manifest-path src-tauri/Cargo.toml <filter>`. Clippy baseline is **50 warnings** — add none: `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "generated [0-9]+ warning"`. "Expected: 50" means "50, or fewer" — never more. New code uses inline format args (`{e}`). Every new Rust item is introduced by the task that first calls it (that is why Task 1 is the whole Rust move); never `#[allow(dead_code)]`.
- **Baselines at the start:** `npx vitest run --dir src` → **84 files / 1769 tests**; cargo → **555 passed / 3 ignored**. Each task states what it adds; totals are cumulative. `npm run test` overcounts — always `--dir src`.
- **Frontend checks:** one file `npx vitest run <file>`; all `npx vitest run --dir src`; types `npm run check` (0 errors; warnings no more than before the task).
- **Final gate (Task 13):** also `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target npm run check:x86` (Task 3 adds an IPC that calls `activate_app`).
- **Never** `npm run tauri dev` / `npm run tauri build` / `npm run build:universal`. Never kill a process you did not start. The CLI talks to the dev build only with `--socket /tmp/md_mini_dev_cmd.sock`.
- **Hotkeys match on `e.code`**; synthetic `KeyboardEvent`s carry `code` and go to `document.activeElement` (tests) or `document.body` (live app).
- Line numbers below are as of `57084df`; earlier tasks shift them. "Replace function `X`" means find it by name.

## Must-haves → tasks

| # | Must-have (architect) | Decision | Task(s) · test |
|---|---|---|---|
| 1 | Keyboard path: «В окно…» on selection / active card, ↑/↓, Enter, Esc; `role=listbox` + `aria-activedescendant` | D10 | 6 (⌘M), 9 (listbox), 10 (`CmdMOpensTheCarouselForTheSelection…`, `CmdMWithoutASelection…`) |
| 2 | A group is one ghost with a counter and lands in its original order | D7 | 1 (`a_move_puts_the_tabs_after…`), 8 (`AGroupGoesInThisWindowsOrder`), 10 (`DroppingOnNewWindowMovesTheGroupInListOrder`) |
| 3 | Source shows the neighbour; last tab closes the source; user stays, toast «Перенесено в #N · Перейти» | D3, D5, D6 | 4 (`removeTabs`), 8 (`MovingTheActiveTab…`, `MovingEveryTab…`), 11 (toast), 13 (QA 1, 4) |
| 4 | Everything moves: untitled buffer, stamps, caret+scroll, inbox, AiPending re-labelled (no `tab released`, target's answer accepted), quick look; atomic under `OpenFiles`, lock orders kept; numbers unchanged; watchers follow; tombstones hold | D1, D2, D12, D13 | 1 (registry, AiPending, session, `tab_move`), 2 (`ai_forward`), 7 (carry/adopt), 8 (outgoing/arrive), 13 (QA 2, 5) |
| 5 | Single window → only «+ Новое окно»; reduced motion → no blur/scroll animation | D8, D11 | 5 (`WithReducedMotionTheEdgeStepsHalfAViewAtATime`), 9 (`WithASingleWindowOffersOnlyANewOne`, reduced-motion CSS), 10 (`CmdMWithoutASelection…` alone; `main` blur CSS), 13 (QA 7; Playwright `reducedMotion: 'reduce'`) |
| 6 | Drag past the window edge → Known gaps | — | Known gaps |
| + | «В новые окна» rewritten onto the same atomic move | D7 | 8 (`MoveToNewWindows…`) |
| + | Dirty file tab: flush then move, refuse with the existing toast | D3 | 8 (`AnActiveFileTabWhoseSaveDidNotLand…`, `ASaveErrorRefusesTheMove`) |

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **One atomic Rust command, `tab_move(tabs, target)`.** Under the one `OpenFiles` lock: validate everything (`TabRegistry::move_tabs` is all-or-nothing), move the registry entries (removed from the source **with a tombstone**, inserted into the target after its active tab in the order given, the target's tombstone for them cleared), re-label `AiPending` for every moved file, and hand the tabs over — `tabs-arrive` to a mounted target, the pending payload of an unmounted one (the same mounted/unmounted decision `queue_tab` makes under the same locks). There is no moment where a file is held by neither window or by both: "claim in target before release in source" is one step. Lock orders kept: `OpenFiles → PendingFiles → FileWatchers`, and a new, documented **`OpenFiles → AiPending`** (safe: nothing locks `AiPending` and then the registry — `ai_respond` releases the registry first). The session snapshot moves after the lock. Window numbers never change: tabs move, windows don't. | Architect's must-have 4. A release-then-claim pair (today's `moveToNewWindows`) fails the agents with `tab released`, loses stamps and caret, and has a window in between where another window may claim the file. |
| D2 | **What moves (`MovedTab`):** untitled text (file tabs: never — the target reads the file; Rust takes paths only from its registry), caret and top line (an agent's pending `enterAt` wins over the old caret), `openedAt`/`viewedAt`/`unviewed`, `transient`/`transientSeenAt`, and the agent inbox items (asks with their deadline, the pulse) — opaque JSON to Rust. **Undo history does not move** (an `EditorState` cannot cross webviews) — Known gaps. The untitled sidecar keeps its file name: `SessionState::move_tab` carries the recorded `untitled` name into the target's entry, so a migrated `untitled-main.md` draft is not orphaned and the prune keeps it. | Must-have 4; plan 03's stamps gotcha ("Plan 05 carries them"). |
| D3 | **Source order (controller `moveNow`):** check (`mayLeave`: flush with retries, then `decideLeave` — a file tab whose save has not landed is **refused with the existing `unsaved-blocked` toast**; a standing `save-error` refuses too; nothing moves) → prepare the next tab (`removeTabs` neighbour rule, D12 of plan 02) → hand over (comment flush + pauses) → **swap synchronously** (stash the leaving active tab, show the neighbour — or, when the window empties, a blank scratch state) → the one `await`: `tab_move` → settle the neighbour, or close the emptied window. On a refusal from Rust the tabs come back to their places in the background with their inbox, and the `tabs-stranded` toast says why. An untitled tab with text moves with its text (it is not a reason to refuse). | Plan 02's rule: nothing awaits between the last dirty check and the swap. With the IPC after the swap, a key typed during it lands in the neighbour, never in a tab that is leaving. |
| D4 | **Target (controller `arriveNow`):** the arrivals go after the target's active tab, in order; the first becomes the active tab if the target's active tab may be left (quiet — no toast in a window the human is not in); otherwise they wait in the background. They are **not** marked unviewed (a human moved them). A blank Untitled in the target gives way (released), as for an agent's open (commit `d8dc89e`). The target never comes forward by itself. | Mockup `moveToWindow`: `w.active = ids[0]`. "Перейти" should land on what was moved. |
| D5 | **The human stays in the source window.** A window built for a move is built `Activation::Background` (kept behind the key window, `keep_behind_key_window`). A quiet toast «Перенесено в #N · Перейти» (`tabs-moved`): the button calls `reveal_other_window(label)`. It dismisses itself after **6 s** — the one self-dismissing toast (it reports a success; every other toast waits for its button). | Must-have 3. |
| D6 | **Moving the last tab(s) closes the emptied source window** after Rust has moved them (`closeWindow`, the ⌘W-last-tab path). This holds for every move, «В новые окна» of all tabs included. Tabs whose files cannot be read and would be the only ones left are released, as `closeNow` does. | Must-have 3. |
| D7 | **Group and new windows.** A group is the drawer's ⇧-selection in **list order** (never the order of clicks); one ghost with a counter (`.ghost.multi` + `.ghost-count`, already built in plan 03). «+ Новое окно» in the carousel = **one** new window holding the whole group; the selection bar's «В новые окна» = one new window per tab, cascaded, as today — both through `tab_move` (untitled tabs now move too; they used to stay). | Mockup `spawnWindow(ids)` vs spec §6 "группа — окнами каскадом" for the bar's action. |
| D8 | **Carousel data is a sibling IPC, `tab_carousel_windows`**, not `routing::windows_now`: the listing is the agents' contract (`mdmini ls --json`) and lacks the label, the branch and the text. Rows: every other live window, **most recently focused first** (`FocusTracker::order`), never-focused ones after in label order; per row `#N`, project, branch of the active file, tab count, active file, and `head` — the first ≤ 2 KB of the active document (the file from disk; an untitled one from its sidecar, so up to one 5 s heartbeat old), cut at a line end, rendered as text through `previewLines`. Thumbnails are data, not screenshots. A single-window app → the carousel shows only «+ Новое окно». | Q2 decision: "thumbnails v1 are data". |
| D9 | **Pointer gesture (mockup `carouselFollow`/`carFrame`):** the carousel is up while a dragged card is over the page right of the drawer (x > drawer right − 4, inside the window); back over the drawer it goes and the list reorders as before; a drop on a thumbnail moves, on the page outside thumbnails cancels; Esc cancels any drag. The top/bottom 22 % of the view glide at `v·|v|·16` px/frame; the wheel scrolls; thumbnails scale to 88 % away from the middle; a still pointer over a scrolling track re-targets (`onscroll`). The pointer never leaves the window — no `cursor_position` polling. | Q2; mockup. |
| D10 | **Keyboard path:** ⌘M (a drawer-only webview key like ⌘L/⌘R/⌘U — not a menu item; collision tests, and `menu.rs` has no predefined Minimize) and the selection bar's «В окно…» open the carousel for the selection, else the card the arrows are on, else the active tab. The track is `role="listbox"` with `aria-activedescendant`; options are `role="option"` with `aria-selected`. The keyboard starts on the most recently focused other window, else on «+ Новое окно»; ↑/↓ move (scrolling it into view), Enter moves the tabs, Esc closes the carousel and gives the keys back to the list; while it is up no other key reaches the search or the editor. A click on a thumbnail works in either mode. | Must-have 1. ⌘M: "Move"; free in the native menu and in CodeMirror. |
| D11 | **Reduced motion:** no blur (the scrim alone dims the page), no transitions or animations (fade-in, «got» pulse, ghost width), and the edge zones **step** half a view every 400 ms instead of gliding. The wheel and the keyboard still scroll (a jump, not an animation). | Must-have 5. |
| D12 | **In-flight agent commands (`ai_forward`).** A command Rust had already delivered to the source when the move ran reaches the source's queue after it and finds the file gone. Instead of answering `the file is open in another window` (and being refused anyway — its request now belongs to the target), the source hands it to the holder: `ai_forward(payload)` re-labels the request (only if it is still waiting and is the caller's or already the holder's) and delivers it there. Also covers a file claimed by another window between routing and delivery. | Must-have 4: agents must not see a move. |
| D13 | **A move is neither a close nor a release:** no `tab_release`/`tab_close`, so no `cancel_for_tab`, no closed-stack entry, no recovery deletion; comment pauses are committed by the hand-over, exactly as for a switch. `AiQueue` is not touched: the caller is mounted (it invoked the command), and `queue_unless_mounted` queues only for unmounted windows. | Keeps the move from doing half of a close. |

### Behaviour the spec leaves open, and what this plan does

| Topic | Spec | Chosen |
|---|---|---|
| target's active tab after a drop | — | the first moved tab, unless the target's active tab may not be left (D4) |
| does the human follow the tabs | — | no; toast «Перейти» (D5) |
| «+ Новое окно» with a group | §6 "группа — окнами каскадом" (drop into the void) | one window for the group; the bar's «В новые окна» keeps one per tab (D7) |
| drop on the page off any thumbnail | — | cancel (mockup `kind: 'none'`) |
| the new window's place on screen | §6 "в точке сброса" | cascade (`build_window`); drop point is part of the edge-drag gap |

---

## File structure

**Rust (`src-tauri/src/`)**
- `tabs.rs` — modify: `MoveRefused`, `TabRegistry::move_tabs` (Task 1).
- `ai_socket.rs` — modify: `AiPending::relabel` (+ test helper `register_waiting`) (Task 1); `AiPending::hand_to`, `AiCommandPayload: Deserialize`, `ai_forward` (Task 2).
- `session.rs` — modify: `SessionState::move_tab` (Task 1).
- `window.rs` — modify: `PendingTab` gains `transient`, `transient_seen_at`, `inbox` (Task 1); `reveal_other_window` (Task 3).
- `tab_commands.rs` — modify: `MovedTab`, `MoveTarget`, `MoveDone`, `Arrival`, `Moved`, `move_tabs_between`, `tab_move` (Task 1); `CarouselWindow`, `read_start`, `tab_carousel_windows` (Task 3).
- `routing.rs` — modify: `CarouselRow`, `carousel_rows`, `cut_head` (Task 3).
- `lib.rs` — modify: command registration (Tasks 1–3).

**Frontend (`src/`)**
- `lib/tabs/tab-model.ts` — modify: `removeTabs` (Task 4).
- `lib/tabs/carousel.ts` — **create**: pure carousel model (Task 5).
- `lib/tabs/drawer-keys.ts`, `lib/tabs/drawer-state.ts` — modify: ⌘M → `{ kind: 'carousel' }` (Task 6).
- `lib/tabs/agent-commands.ts` — modify: `forward` dep, `carry`, `adopt` (Task 7).
- `lib/tabs/controller.ts` — modify: `InitTab` carries quick look + inbox, `arriveNow`, `moveNow`, `moveTabs`, `arrive`, `moveToNewWindows` rewritten; `detachNow`/`adoptNow` removed (Task 8).
- `lib/tabs/tab-name.ts` — modify: `tabNames` takes untitled entries (Task 8).
- `lib/tauri/commands.ts`, `lib/tauri/events.ts` — modify: `PendingTab` fields, `onTabsArrive` (Task 8).
- `lib/tabs/WindowCarousel.svelte` — **create** (Task 9).
- `lib/tabs/TabDrawer.svelte` — modify: drag-out, keyboard carousel, ghost bar, «В окно…» (Task 10).
- `lib/toasts.svelte.ts`, `lib/ToastStack.svelte` — modify: `tabs-moved` (Task 11).
- `App.svelte` — modify (Tasks 7, 8, 10, 11).
- `locales/{ru,en,de,fr,es,zh}/app.json` — modify (Tasks 9, 10, 11).
- Tests colocated: `*.test.ts` / `*.svelte.test.ts` next to each module; Rust tests in each module's `tests`.
- Docs: `CLAUDE.md`, `docs/ai-interface.md`, `docs/superpowers/plans/tabs-questions.md` (Task 12).

---

## Task 1: The atomic move in Rust — registry, agents, session, `tab_move`

Everything Rust does for a move, in one task because each piece is first called by `tab_move` (Working rules: no item before its caller).

**Files:**
- Modify: `src-tauri/src/tabs.rs` (after `set_active` l.203–212; tests)
- Modify: `src-tauri/src/ai_socket.rs` (`impl AiPending` l.455–562; tests)
- Modify: `src-tauri/src/session.rs` (after `SessionState::remove_tab` l.427–440; tests)
- Modify: `src-tauri/src/window.rs` (`PendingTab` l.21–35, `pending_tab_from_snapshot` l.39–53)
- Modify: `src-tauri/src/tab_commands.rs` (imports l.5–12; after `tab_close` l.245–286; tests)
- Modify: `src-tauri/src/lib.rs` (`invoke_handler`, after `tab_commands::tab_close`)

- [ ] **Step 1: Failing tests — the registry move (`tabs.rs` tests)**

Append to `mod tests` in `src-tauri/src/tabs.rs`:

```rust
    fn ids_of(reg: &TabRegistry, label: &str) -> Vec<String> {
        reg.window(label).map(|w| w.tabs.iter().map(|t| t.id.clone()).collect()).unwrap_or_default()
    }

    fn strings(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_move_puts_the_tabs_after_the_targets_active_tab_in_the_order_given() {
        let mut reg = reg_with(&[
            ("main", "a", Some("/a.md")),
            ("main", "b", Some("/b.md")),
            ("main", "c", None),
            ("editor-2", "x", Some("/x.md")),
            ("editor-2", "y", Some("/y.md")),
        ]);
        let moved = reg.move_tabs("main", "editor-2", &strings(&["c", "a"])).unwrap();
        assert_eq!(moved.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["c", "a"]);
        assert_eq!(ids_of(&reg, "main"), vec!["b"]);
        assert_eq!(ids_of(&reg, "editor-2"), vec!["x", "c", "a", "y"], "right after x, the active tab");
        assert_eq!(reg.owner_of("/a.md"), Some(("editor-2".to_string(), "a".to_string())), "the file went with its tab");
        assert_eq!(reg.paths().iter().filter(|p| p.as_str() == "/a.md").count(), 1, "one file, one tab");
    }

    #[test]
    fn a_move_is_all_or_nothing() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("editor-2", "x", None)]);
        assert_eq!(
            reg.move_tabs("main", "editor-2", &strings(&["a", "x"])),
            Err(MoveRefused::NotHere("x".to_string()))
        );
        assert_eq!(reg.move_tabs("main", "main", &strings(&["a"])), Err(MoveRefused::SameWindow));
        assert_eq!(reg.move_tabs("main", "editor-2", &[]), Err(MoveRefused::Nothing));
        assert_eq!(ids_of(&reg, "main"), vec!["a"]);
        assert_eq!(ids_of(&reg, "editor-2"), vec!["x"]);
        assert!(reg.window("main").unwrap().closed_ids.is_empty(), "nothing tombstoned");
    }

    #[test]
    fn the_sources_active_tab_falls_to_its_first_remaining_one_and_the_target_keeps_its_own() {
        let mut reg = reg_with(&[("main", "a", None), ("main", "b", None), ("editor-2", "x", None)]);
        reg.move_tabs("main", "editor-2", &strings(&["a"])).unwrap();
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("b"));
        assert_eq!(reg.window("editor-2").unwrap().active.as_deref(), Some("x"));
    }

    #[test]
    fn a_window_built_for_the_move_takes_the_first_moved_tab_as_active_and_keeps_its_number() {
        let mut reg = reg_with(&[("main", "a", None), ("main", "b", None)]);
        reg.set_number("editor-3", Some(3));
        reg.move_tabs("main", "editor-3", &strings(&["a", "b"])).unwrap();
        let w = reg.window("editor-3").unwrap();
        assert_eq!(w.active.as_deref(), Some("a"));
        assert_eq!(w.number, Some(3), "numbers never change");
        assert_eq!(reg.window("main").unwrap().active, None, "an emptied window has none");
    }

    #[test]
    fn a_heartbeat_the_source_sent_before_the_move_does_not_bring_the_tab_back() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "u", None), ("editor-2", "x", None)]);
        let stale = [("a".to_string(), Some("/a.md".to_string())), ("u".to_string(), None)];
        reg.move_tabs("main", "editor-2", &strings(&["u"])).unwrap();
        reg.sync("main", &stale, Some("u"));
        assert_eq!(ids_of(&reg, "main"), vec!["a"]);
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("a"));
        assert!(reg.window("main").unwrap().closed_ids.contains("u"));
        assert_eq!(ids_of(&reg, "editor-2"), vec!["x", "u"]);
    }

    #[test]
    fn moving_a_tab_back_clears_its_tombstone_there() {
        let mut reg = reg_with(&[("main", "a", None), ("main", "u", None), ("editor-2", "x", None)]);
        reg.move_tabs("main", "editor-2", &strings(&["u"])).unwrap();
        reg.move_tabs("editor-2", "main", &strings(&["u"])).unwrap();
        assert!(!reg.window("main").unwrap().closed_ids.contains("u"));
        assert!(reg.window("editor-2").unwrap().closed_ids.contains("u"));
        reg.sync("main", &[("a".to_string(), None), ("u".to_string(), None)], Some("u"));
        assert_eq!(reg.window("main").unwrap().active.as_deref(), Some("u"));
    }

    #[test]
    fn an_id_given_twice_moves_once() {
        let mut reg = reg_with(&[("main", "a", None), ("main", "b", None), ("editor-2", "x", None)]);
        assert_eq!(reg.move_tabs("main", "editor-2", &strings(&["a", "a"])).unwrap().len(), 1);
        assert_eq!(ids_of(&reg, "editor-2"), vec!["x", "a"]);
    }

    #[test]
    fn a_refused_move_says_why() {
        assert_eq!(MoveRefused::NotHere("x".into()).to_string(), "tab x is not in this window");
        assert_eq!(MoveRefused::SameWindow.to_string(), "the tabs are in that window already");
        assert_eq!(MoveRefused::Nothing.to_string(), "nothing to move");
    }
```

- [ ] **Step 2: Run — fails to compile**

Run: `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target cargo test --manifest-path src-tauri/Cargo.toml tabs::tests 2>&1 | tail -5`
Expected: `error[E0599]: no method named move_tabs` / `cannot find type MoveRefused`.

- [ ] **Step 3: Implement `move_tabs`**

In `src-tauri/src/tabs.rs`, after `pub struct RegTab { … }`:

```rust
/// Why `TabRegistry::move_tabs` changed nothing.
#[derive(Debug, PartialEq, Eq)]
pub enum MoveRefused {
    Nothing,
    SameWindow,
    /// This id is not one of the source window's tabs.
    NotHere(String),
}

impl std::fmt::Display for MoveRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Nothing => write!(f, "nothing to move"),
            Self::SameWindow => write!(f, "the tabs are in that window already"),
            Self::NotHere(id) => write!(f, "tab {id} is not in this window"),
        }
    }
}
```

In `impl TabRegistry`, after `set_active`:

```rust
    /// Move tabs `ids` from `from` to `to` (plan 05), in the order given,
    /// right after `to`'s active tab — at its end when it has none. All or
    /// nothing: refused, with nothing changed, when no id is given, the two
    /// are one window, or any id is not one of `from`'s tabs. Paths go with
    /// their tabs, so one file stays one tab.
    ///
    /// Each moved id is tombstoned in `from` — a heartbeat it sent before the
    /// move must not bring the tab back there (`sync`) nor, through the
    /// session, its draft — and un-tombstoned in `to`. `from`'s active tab,
    /// if it moved, falls to its first remaining tab until its frontend says
    /// otherwise; `to` keeps its own, or takes the first moved one.
    pub fn move_tabs(&mut self, from: &str, to: &str, ids: &[String]) -> Result<Vec<RegTab>, MoveRefused> {
        if ids.is_empty() {
            return Err(MoveRefused::Nothing);
        }
        if from == to {
            return Err(MoveRefused::SameWindow);
        }
        let mut unique: Vec<&String> = Vec::with_capacity(ids.len());
        for id in ids {
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        let held = |id: &String| self.windows.get(from).is_some_and(|w| w.tabs.iter().any(|t| &t.id == id));
        if let Some(stranger) = unique.iter().find(|id| !held(id)) {
            return Err(MoveRefused::NotHere((*stranger).clone()));
        }
        let Some(source) = self.windows.get_mut(from) else {
            return Err(MoveRefused::NotHere(ids[0].clone()));
        };
        let mut moved = Vec::with_capacity(unique.len());
        for id in unique {
            if let Some(at) = source.tabs.iter().position(|t| &t.id == id) {
                let tab = source.tabs.remove(at);
                source.closed_ids.insert(tab.id.clone());
                moved.push(tab);
            }
        }
        if source.active.as_ref().is_some_and(|a| moved.iter().any(|t| &t.id == a)) {
            source.active = source.tabs.first().map(|t| t.id.clone());
        }
        let target = self.windows.entry(to.to_string()).or_default();
        let at = target
            .active
            .as_ref()
            .and_then(|a| target.tabs.iter().position(|t| &t.id == a))
            .map_or(target.tabs.len(), |i| i + 1);
        for (k, tab) in moved.iter().enumerate() {
            target.closed_ids.remove(&tab.id);
            target.tabs.insert(at + k, tab.clone());
        }
        if target.active.is_none() {
            target.active = moved.first().map(|t| t.id.clone());
        }
        Ok(moved)
    }
```

- [ ] **Step 4: Run the registry tests**

Run: `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target cargo test --manifest-path src-tauri/Cargo.toml tabs::tests 2>&1 | grep -E "^test result"`
Expected: `ok`, 8 more than before. (`move_tabs` is unused outside tests until Step 13 — do not run clippy before then.)

- [ ] **Step 5: Failing tests — agents follow the file (`ai_socket.rs` tests)**

Append to `mod tests` in `src-tauri/src/ai_socket.rs`:

```rust
    #[test]
    fn relabel_hands_a_moved_documents_agents_to_the_target_window() {
        let pending = AiPending::new();
        let (moved, rx) = waiting(&pending, "main", Some("/a.md"));
        let (_other_doc, _rx2) = waiting(&pending, "main", Some("/b.md"));
        assert_eq!(pending.relabel("main", "editor-2", "/a.md"), 1);
        assert!(
            pending.respond_from(moved, "main", AiResponse::ok()).is_err(),
            "the old window no longer answers it"
        );
        pending.cancel_for_window("main");
        assert!(pending.is_pending(moved), "closing the old window does not fail it");
        pending.respond_from(moved, "editor-2", AiResponse::ok()).unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap().ok);
    }

    #[test]
    fn relabel_leaves_other_windows_and_pathless_requests_alone() {
        let pending = AiPending::new();
        let (elsewhere, _r1) = waiting(&pending, "editor-3", Some("/a.md"));
        let (pathless, _r2) = waiting(&pending, "main", None);
        assert_eq!(pending.relabel("main", "editor-2", "/a.md"), 0);
        assert_eq!(pending.label_of(elsewhere).as_deref(), Some("editor-3"));
        assert_eq!(pending.label_of(pathless).as_deref(), Some("main"), "a close request has no document to follow");
    }
```

- [ ] **Step 6: Implement `relabel` (and two test helpers)**

In `impl AiPending`, after `cancel_for_window_and_path`:

```rust
    /// The tab holding `path` moved from window `from` to `to` (`tab_move`):
    /// its agents wait on `to` from now on — an answer from there is
    /// accepted (`respond_from`), closing `to` fails them, closing `from`
    /// no longer does. Called under the `OpenFiles` lock (lock order
    /// `OpenFiles → AiPending`; nothing takes them the other way round).
    /// Returns how many requests followed the file.
    pub fn relabel(&self, from: &str, to: &str, path: &str) -> usize {
        let mut map = self.map.lock().unwrap();
        let mut n = 0;
        for entry in map.values_mut().filter(|e| e.label == from && e.path.as_deref() == Some(path)) {
            entry.label = to.to_string();
            n += 1;
        }
        n
    }

    #[cfg(test)]
    fn label_of(&self, id: u64) -> Option<String> {
        self.map.lock().unwrap().get(&id).map(|e| e.label.clone())
    }

    /// A waiting request, for tests in other modules (`register` is private).
    #[cfg(test)]
    pub(crate) fn register_waiting(&self, label: &str, path: Option<&str>) -> (u64, mpsc::Receiver<AiResponse>) {
        let (tx, rx) = mpsc::channel();
        let id = self.alloc_id();
        self.register(id, label, path.map(str::to_string), tx);
        (id, rx)
    }
```

Run: `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target cargo test --manifest-path src-tauri/Cargo.toml relabel 2>&1 | grep -E "^test result"` → `2 passed`.

- [ ] **Step 7: Failing tests — the session follows (`session.rs` tests)**

Append to `mod tests` in `src-tauri/src/session.rs`:

```rust
    fn moved_snap(id: &str, path: Option<&str>) -> TabSnapshot {
        TabSnapshot { tab_id: id.to_string(), path: path.map(str::to_string), top_line: 1, ..Default::default() }
    }

    #[test]
    fn a_moved_tab_takes_its_snapshot_and_sidecar_name_to_the_target() {
        let state = SessionState::new();
        state.set_tabs(
            "main",
            vec![
                moved_snap("a", Some("/a.md")),
                TabSnapshot { untitled: Some("untitled-main.md".into()), ..moved_snap("u", None) },
            ],
            Some("u".into()),
        );
        state.set_tabs("editor-2", vec![moved_snap("x", None)], Some("x".into()));
        state.move_tab("main", "editor-2", TabSnapshot { cursor: 4, opened_at: 7, ..moved_snap("u", None) });

        let main = state.snapshot_for("main").unwrap();
        assert_eq!(main.tabs.iter().map(|t| t.tab_id.as_str()).collect::<Vec<_>>(), vec!["a"]);
        assert_eq!(main.active_tab.as_deref(), Some("a"));
        let target = state.snapshot_for("editor-2").unwrap();
        let u = target.tabs.iter().find(|t| t.tab_id == "u").unwrap();
        assert_eq!(u.untitled.as_deref(), Some("untitled-main.md"), "a migrated draft keeps writing to its file");
        assert_eq!((u.cursor, u.opened_at), (4, 7));
        assert_eq!(state.untitled_file_for("editor-2", "u"), "untitled-main.md");
    }

    #[test]
    fn a_moved_draft_stays_referenced_so_the_prune_keeps_it() {
        let state = SessionState::new();
        state.set_tabs(
            "main",
            vec![TabSnapshot { untitled: Some("untitled-1-2-3.md".into()), ..moved_snap("1-2-3", None) }],
            None,
        );
        state.move_tab("main", "editor-4", moved_snap("1-2-3", None));
        assert!(state.referenced_untitled().contains("untitled-1-2-3.md"));
    }

    #[test]
    fn a_tab_the_source_never_recorded_still_lands_in_the_target() {
        let state = SessionState::new();
        state.move_tab("main", "editor-2", moved_snap("n", Some("/n.md")));
        assert_eq!(state.snapshot_for("editor-2").unwrap().tabs, vec![moved_snap("n", Some("/n.md"))]);
    }

    #[test]
    fn move_tab_changes_nothing_while_quitting() {
        let state = SessionState::new();
        state.set_tabs("main", vec![moved_snap("a", None)], None);
        state.mark_quitting();
        state.move_tab("main", "editor-2", moved_snap("a", None));
        assert_eq!(state.snapshot_for("main").unwrap().tabs.len(), 1);
        assert!(state.snapshot_for("editor-2").is_none());
    }
```

- [ ] **Step 8: Implement `SessionState::move_tab`**

After `SessionState::remove_tab`:

```rust
    /// A tab moved to another window (`tab_move`): its snapshot leaves
    /// `from`'s entry and joins `to`'s now, not at the next heartbeat — a
    /// quit in between would otherwise restore it in neither window. The
    /// `untitled` name the source recorded is kept, so the draft goes on
    /// being written to (and referenced as) the file it already has.
    pub fn move_tab(&self, from: &str, to: &str, mut tab: TabSnapshot) {
        if self.is_quitting() {
            return;
        }
        let mut map = self.entries.lock().unwrap();
        let old = map.get_mut(from).and_then(|w| {
            let at = w.tabs.iter().position(|t| t.tab_id == tab.tab_id)?;
            let old = w.tabs.remove(at);
            if w.active_tab.as_deref() == Some(tab.tab_id.as_str()) {
                w.active_tab = w.tabs.first().map(|t| t.tab_id.clone());
            }
            Some(old)
        });
        if tab.untitled.is_none() {
            tab.untitled = old.and_then(|t| t.untitled);
        }
        let entry = map.entry(to.to_string()).or_insert_with(WindowSnapshot::empty);
        entry.tabs.retain(|t| t.tab_id != tab.tab_id);
        entry.tabs.push(tab);
        drop(map);
        self.touch();
    }
```

Run: `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target cargo test --manifest-path src-tauri/Cargo.toml session::tests 2>&1 | grep -E "^test result"` → `ok`, 4 more.

- [ ] **Step 9: `PendingTab` carries a quick look and the inbox (`window.rs`)**

Add to `pub struct PendingTab` after `unviewed`:

```rust
    /// A quick look (spec §7) carried by a move between windows (plan 05);
    /// `false` for every other tab — a quick look is not persisted.
    pub transient: bool,
    pub transient_seen_at: u64,
    /// What waited for the tab in its old window's agent inbox (asks with
    /// their deadlines, a pulse): the frontend's own items, carried
    /// untouched by `tab_move`. Absent for every tab that did not move.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inbox: Option<serde_json::Value>,
```

In `pending_tab_from_snapshot`, add `..Default::default()` after `unviewed: tab.unviewed,` (it is the only literal that names every field; the others already end in `..Default::default()`).

- [ ] **Step 10: Failing tests — the move command's core (`tab_commands.rs` tests)**

Append to `mod tests` in `src-tauri/src/tab_commands.rs` (add `use crate::ai_socket::{AiPending, AiResponse};` at the top of the module):

```rust
    fn moved(id: &str) -> MovedTab {
        MovedTab { tab_id: id.to_string(), cursor: 3, top_line: 2, opened_at: 10, viewed_at: 20, ..Default::default() }
    }

    #[test]
    fn a_move_to_a_mounted_window_hands_the_tabs_over_as_one_event() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "u", None), ("main", "k", None), ("editor-2", "x", None)]);
        reg.mark_mounted("editor-2");
        let tabs = vec![
            MovedTab { content: Some("draft".into()), unviewed: true, inbox: Some(serde_json::json!([{ "kind": "pulse" }])), ..moved("u") },
            MovedTab { content: Some("never the file's".into()), transient: true, transient_seen_at: 5, ..moved("a") },
        ];
        let out = move_tabs_between(&mut reg, &mut HashMap::new(), &AiPending::new(), "main", "editor-2", tabs, |_| true).unwrap();
        let Arrival::Event(arriving) = out.arrival else { panic!("the target is mounted") };
        assert_eq!(arriving.iter().map(|t| t.tab_id.as_str()).collect::<Vec<_>>(), vec!["u", "a"]);
        assert_eq!(arriving[0].content.as_deref(), Some("draft"));
        assert_eq!(arriving[0].inbox, Some(serde_json::json!([{ "kind": "pulse" }])));
        assert!(arriving[0].unviewed);
        assert_eq!(arriving[1].path.as_deref(), Some("/a.md"), "the registry's path, never the frontend's");
        assert_eq!(arriving[1].content, None, "a file tab's text comes from its file");
        assert_eq!(
            (arriving[1].cursor, arriving[1].top_line, arriving[1].opened_at, arriving[1].viewed_at),
            (3, 2, 10, 20)
        );
        assert!(arriving[1].transient);
        assert_eq!(arriving[1].transient_seen_at, 5);
        assert_eq!(
            out.snapshots.iter().map(|s| (s.tab_id.as_str(), s.path.as_deref())).collect::<Vec<_>>(),
            vec![("u", None), ("a", Some("/a.md"))]
        );
    }

    #[test]
    fn a_move_to_a_window_that_has_not_mounted_waits_in_its_payload() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "b", Some("/b.md"))]);
        reg.set_number("editor-5", Some(5));
        let mut pending = HashMap::new();
        let out = move_tabs_between(&mut reg, &mut pending, &AiPending::new(), "main", "editor-5", vec![moved("a"), moved("b")], |_| true)
            .unwrap();
        assert_eq!(out.arrival, Arrival::Pending);
        let payload = pending.get("editor-5").expect("queued for its mount");
        assert_eq!(payload.active_tab_id.as_deref(), Some("a"));
        assert_eq!(payload.tabs.iter().map(|t| t.tab_id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert!(out.source_active_moved, "a was main's active tab: its watcher must stop");
    }

    #[test]
    fn a_move_to_a_window_that_is_gone_changes_nothing() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("editor-2", "x", None)]);
        let err = move_tabs_between(&mut reg, &mut HashMap::new(), &AiPending::new(), "main", "editor-2", vec![moved("a")], |l| l != "editor-2")
            .unwrap_err();
        assert_eq!(err, "window editor-2 is gone");
        assert_eq!(reg.label_of("/a.md").as_deref(), Some("main"));
    }

    #[test]
    fn a_background_tab_moving_leaves_the_source_watcher_alone() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("main", "b", Some("/b.md")), ("editor-2", "x", None)]);
        reg.mark_mounted("editor-2");
        let out = move_tabs_between(&mut reg, &mut HashMap::new(), &AiPending::new(), "main", "editor-2", vec![moved("b")], |_| true)
            .unwrap();
        assert!(!out.source_active_moved);
    }

    #[test]
    fn the_agents_of_a_moved_file_wait_on_the_target() {
        let mut reg = reg_with(&[("main", "a", Some("/a.md")), ("editor-2", "x", None)]);
        reg.mark_mounted("editor-2");
        let agents = AiPending::new();
        let (id, rx) = agents.register_waiting("main", Some("/a.md"));
        move_tabs_between(&mut reg, &mut HashMap::new(), &agents, "main", "editor-2", vec![moved("a")], |_| true).unwrap();
        assert!(agents.respond_from(id, "main", AiResponse::ok()).is_err(), "never `tab released`, and not the source's any more");
        agents.respond_from(id, "editor-2", AiResponse::ok()).unwrap();
        assert!(rx.try_recv().unwrap().ok, "answered from its new window");
    }

    #[test]
    fn the_move_speaks_the_frontends_json() {
        let tab: MovedTab = serde_json::from_str(
            r#"{"tabId":"1-2-3","content":"x","cursor":4,"topLine":2,"openedAt":5,"viewedAt":6,"unviewed":true,"transient":true,"transientSeenAt":7,"inbox":[]}"#,
        )
        .unwrap();
        assert_eq!(
            tab,
            MovedTab {
                tab_id: "1-2-3".into(),
                content: Some("x".into()),
                cursor: 4,
                top_line: 2,
                opened_at: 5,
                viewed_at: 6,
                unviewed: true,
                transient: true,
                transient_seen_at: 7,
                inbox: Some(serde_json::json!([])),
            }
        );
        assert_eq!(
            serde_json::from_str::<MoveTarget>(r#"{"kind":"window","label":"editor-2"}"#).unwrap(),
            MoveTarget::Window { label: "editor-2".into() }
        );
        assert_eq!(serde_json::from_str::<MoveTarget>(r#"{"kind":"new-window"}"#).unwrap(), MoveTarget::NewWindow);
        assert_eq!(
            serde_json::to_string(&MoveDone { label: "editor-2".into(), number: Some(7) }).unwrap(),
            r#"{"label":"editor-2","number":7}"#
        );
        let pending = serde_json::to_value(PendingTab { tab_id: "u".into(), transient: true, transient_seen_at: 3, ..Default::default() })
            .unwrap();
        assert_eq!(pending["transientSeenAt"], 3);
        assert!(pending.get("inbox").is_none(), "absent unless carried");
    }
```

Run: `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target cargo test --manifest-path src-tauri/Cargo.toml tab_commands 2>&1 | tail -3` → compile errors (`MovedTab`, `move_tabs_between` unknown).

- [ ] **Step 11: Implement the core and the command (`tab_commands.rs`)**

Imports at the top become:

```rust
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::session::{SessionState, TabSnapshot};
use crate::tabs::{MoveRefused, TabRegistry};
use crate::window::{self, OpenFiles, PendingFiles, PendingOpen, PendingTab};
```

After `tab_close`:

```rust
/// One tab as its old window hands it over (plan 05) — `MovedTab` in
/// `lib/tabs/controller.ts`. No path: Rust takes a tab's file from its
/// registry, never from a frontend.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MovedTab {
    pub tab_id: String,
    /// An untitled tab's text. Ignored for a file tab: the target reads the file.
    pub content: Option<String>,
    pub cursor: usize,
    pub top_line: usize,
    pub opened_at: u64,
    pub viewed_at: u64,
    pub unviewed: bool,
    pub transient: bool,
    pub transient_seen_at: u64,
    /// The agent inbox items that waited for the tab, untouched.
    pub inbox: Option<serde_json::Value>,
}

impl MovedTab {
    fn into_pending(self, path: Option<String>) -> PendingTab {
        PendingTab {
            content: if path.is_none() { self.content } else { None },
            path,
            tab_id: self.tab_id,
            cursor: self.cursor,
            top_line: self.top_line.max(1),
            opened_at: self.opened_at,
            viewed_at: self.viewed_at,
            unviewed: self.unviewed,
            transient: self.transient,
            transient_seen_at: self.transient_seen_at,
            inbox: self.inbox,
        }
    }
}

/// Where `tab_move` sends tabs.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MoveTarget {
    Window { label: String },
    /// A window built for them, in the background (D5).
    NewWindow,
}

/// `tab_move`'s answer: the window the tabs are in now.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct MoveDone {
    pub label: String,
    pub number: Option<u32>,
}

/// How moved tabs reach the target's frontend.
#[derive(Debug, PartialEq)]
pub enum Arrival {
    /// It has mounted: they go to it as one `tabs-arrive` event.
    Event(Vec<PendingTab>),
    /// It has not (a window built for the move): they wait in its payload.
    Pending,
}

/// What `move_tabs_between` did.
#[derive(Debug, PartialEq)]
pub struct Moved {
    pub arrival: Arrival,
    /// The session snapshots of the moved tabs, for `SessionState::move_tab`.
    pub snapshots: Vec<TabSnapshot>,
    /// The source's active tab moved: its watcher stops until the source
    /// shows its next tab (`tab_activate`).
    pub source_active_moved: bool,
}

/// The move itself (D1), with the `OpenFiles` and `PendingFiles` locks held:
/// the registry, the agents' requests for the moved files, and the hand-over
/// — an event for a mounted target, its payload otherwise. `get_window_init`
/// takes the payload and marks the window mounted under the same two locks,
/// so a payload is never appended to after it was pulled. Nothing changes
/// when the target is gone or the registry refuses.
pub fn move_tabs_between(
    reg: &mut TabRegistry,
    pending: &mut HashMap<String, PendingOpen>,
    agents: &crate::ai_socket::AiPending,
    from: &str,
    to: &str,
    tabs: Vec<MovedTab>,
    is_live: impl Fn(&str) -> bool,
) -> Result<Moved, String> {
    if !is_live(to) {
        return Err(format!("window {to} is gone"));
    }
    let ids: Vec<String> = tabs.iter().map(|t| t.tab_id.clone()).collect();
    let was_active = reg.window(from).and_then(|w| w.active.clone());
    let moved = reg.move_tabs(from, to, &ids).map_err(|e| e.to_string())?;
    for path in moved.iter().filter_map(|t| t.path.as_deref()) {
        agents.relabel(from, to, path);
    }
    let arriving: Vec<PendingTab> = moved
        .iter()
        .map(|reg_tab| {
            let carried = tabs.iter().find(|t| t.tab_id == reg_tab.id).cloned().unwrap_or_default();
            carried.into_pending(reg_tab.path.clone())
        })
        .collect();
    let snapshots = arriving
        .iter()
        .map(|t| TabSnapshot {
            tab_id: t.tab_id.clone(),
            path: t.path.clone(),
            untitled: None,
            cursor: t.cursor,
            top_line: t.top_line,
            opened_at: t.opened_at,
            viewed_at: t.viewed_at,
            unviewed: t.unviewed,
        })
        .collect();
    let arrival = if reg.is_mounted(to) {
        Arrival::Event(arriving)
    } else {
        let entry = pending.entry(to.to_string()).or_default();
        if entry.active_tab_id.is_none() {
            entry.active_tab_id = arriving.first().map(|t| t.tab_id.clone());
        }
        entry.tabs.extend(arriving);
        Arrival::Pending
    };
    let source_active_moved = was_active.is_some_and(|a| moved.iter().any(|t| t.id == a));
    Ok(Moved { arrival, snapshots, source_active_moved })
}

/// Move `tabs` of the calling window to `target` (plan 05, D1). A window
/// built for them is built before the registry lock (`build_window` takes it
/// to number the window), in the background, and destroyed again when the
/// move is refused. Never a close or a release (D13): the agents keep
/// waiting — on the target now.
#[tauri::command]
pub async fn tab_move(
    app: AppHandle,
    window: tauri::WebviewWindow,
    tabs: Vec<MovedTab>,
    target: MoveTarget,
) -> Result<MoveDone, String> {
    let from = window.label().to_string();
    if tabs.is_empty() {
        return Err(MoveRefused::Nothing.to_string());
    }
    if let Some(bad) = tabs.iter().find(|t| !crate::session::is_valid_tab_id(&t.tab_id)) {
        return Err(format!("invalid tab id: {:?}", bad.tab_id));
    }
    let (to, built) = match target {
        MoveTarget::Window { label } => (label, false),
        MoveTarget::NewWindow => (window::build_window(&app, window::Activation::Background)?, true),
    };
    let outcome = {
        let open_files = app.state::<OpenFiles>();
        let mut reg = open_files.0.lock().unwrap();
        let moved = {
            let pending = app.state::<PendingFiles>();
            let mut pending = pending.0.lock().unwrap();
            let agents = app.state::<crate::ai_socket::AiPending>();
            move_tabs_between(&mut reg, &mut pending, &agents, &from, &to, tabs, live_windows(&app))
        };
        if moved.as_ref().is_ok_and(|m| m.source_active_moved) {
            window::set_watcher(&app, &from, None);
        }
        moved.map(|m| (m, reg.window(&to).and_then(|w| w.number)))
    };
    let (moved, number) = match outcome {
        Ok(ok) => ok,
        Err(e) => {
            if built {
                if let Some(win) = app.get_webview_window(&to) {
                    let _ = win.destroy();
                }
            }
            return Err(e);
        }
    };
    let session = app.state::<SessionState>();
    for snapshot in moved.snapshots {
        session.move_tab(&from, &to, snapshot);
    }
    if let Arrival::Event(arriving) = moved.arrival {
        if let Err(e) = app.emit_to(to.as_str(), "tabs-arrive", &arriving) {
            eprintln!("tab_move: {to} did not get its tabs: {e}");
        }
    }
    Ok(MoveDone { label: to, number })
}
```

In `src-tauri/src/lib.rs`, register `tab_commands::tab_move,` after `tab_commands::tab_close,`.

- [ ] **Step 12: Run every Rust test**

Run: `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result"`
Expected: `575 passed; 0 failed; 3 ignored` (+20: 8 registry, 2 agents, 4 session, 6 move).

- [ ] **Step 13: Clippy**

Run: the clippy line. Expected: `50 warnings` (no more).

- [ ] **Step 14: Commit**

```bash
git add src-tauri/src/tabs.rs src-tauri/src/ai_socket.rs src-tauri/src/session.rs src-tauri/src/window.rs src-tauri/src/tab_commands.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(tabs): tab_move — one atomic move of tabs between windows

Registry, the agents' requests and the hand-over under the one OpenFiles
lock; the session snapshot and the untitled sidecar name follow.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src-tauri/src/tabs.rs src-tauri/src/ai_socket.rs src-tauri/src/session.rs src-tauri/src/window.rs src-tauri/src/tab_commands.rs src-tauri/src/lib.rs
```

---

## Task 2: `ai_forward` — a command that reached the old window

D12: a command emitted to the source just before a move lands in its queue after the move. This task lets the source hand it on instead of answering (and being refused).

**Files:**
- Modify: `src-tauri/src/ai_socket.rs` (`AiCommandPayload` derive l.641; `impl AiPending`; after `ai_pull_pending` l.1051–1057; tests)
- Modify: `src-tauri/src/lib.rs` (register after `ai_socket::ai_is_pending`)

- [ ] **Step 1: Failing tests**

Append to `mod tests` in `src-tauri/src/ai_socket.rs`:

```rust
    #[test]
    fn hand_to_takes_a_request_of_the_caller_or_already_of_the_holder_only() {
        let pending = AiPending::new();
        let (mine, _r1) = waiting(&pending, "main", Some("/a.md"));
        let (relabelled, _r2) = waiting(&pending, "editor-2", Some("/b.md"));
        let (theirs, _r3) = waiting(&pending, "editor-3", Some("/c.md"));
        assert!(pending.hand_to(mine, "main", "editor-2"));
        assert_eq!(pending.label_of(mine).as_deref(), Some("editor-2"));
        assert!(pending.hand_to(relabelled, "main", "editor-2"), "a move relabelled it already");
        assert!(!pending.hand_to(theirs, "main", "editor-2"), "another window's request is not ours to give");
        assert_eq!(pending.label_of(theirs).as_deref(), Some("editor-3"));
        assert!(!pending.hand_to(9999, "main", "editor-2"), "nobody waits");
    }

    #[test]
    fn a_command_payload_comes_back_from_the_frontend_as_it_went() {
        let p = AiCommandPayload {
            id: 7,
            cmd: "ask".into(),
            path: "/a.md".into(),
            line: Some(2),
            find: None,
            content: None,
            show: false,
            question: Some("Q?".into()),
            options: vec!["Yes".into()],
            timeout_secs: 30,
            multi: false,
            free_text: true,
            first_use: false,
            focus: false,
            transient: false,
            fresh: true,
        };
        let json = serde_json::to_value(&p).unwrap();
        let back: AiCommandPayload = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap(), json);
    }
```

Run: `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target cargo test --manifest-path src-tauri/Cargo.toml hand_to 2>&1 | tail -3` → compile errors.

- [ ] **Step 2: Implement**

`AiCommandPayload`'s derive becomes `#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]`.

In `impl AiPending`, after `relabel`:

```rust
    /// Hand request `id` to window `to`: it reached `from` for a file `to`
    /// holds now — its tab moved there, or was claimed there meanwhile.
    /// Only while someone still waits on it and it is `from`'s, or already
    /// `to`'s (a move relabelled it). `false`: nothing changed.
    pub fn hand_to(&self, id: u64, from: &str, to: &str) -> bool {
        let mut map = self.map.lock().unwrap();
        match map.get_mut(&id) {
            Some(entry) if entry.label == from || entry.label == to => {
                entry.label = to.to_string();
                true
            }
            _ => false,
        }
    }
```

After `ai_pull_pending`:

```rust
/// IPC: a command reached this window for a file another live window holds
/// now (plan 05, D12). Delivered there when its request can be handed over
/// (`AiPending::hand_to`). `false`: nothing was forwarded — the caller
/// answers the agent itself, as before.
#[tauri::command]
pub async fn ai_forward(app: AppHandle, window: tauri::WebviewWindow, payload: AiCommandPayload) -> Result<bool, String> {
    let caller = window.label().to_string();
    let holder = {
        let open_files = app.state::<window::OpenFiles>();
        let reg = open_files.0.lock().unwrap();
        reg.label_of(&payload.path)
    }
    .filter(|label| label != &caller && app.get_webview_window(label).is_some());
    let Some(holder) = holder else {
        return Ok(false);
    };
    if !app.state::<AiPending>().hand_to(payload.id, &caller, &holder) {
        return Ok(false);
    }
    deliver(&app, &holder, payload);
    Ok(true)
}
```

Register `ai_socket::ai_forward,` in `lib.rs` after `ai_socket::ai_is_pending,`.

- [ ] **Step 3: Run**

Run: `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result"` → `577 passed; 0 failed; 3 ignored`. Clippy → `50 warnings`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/ai_socket.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(ai): ai_forward — a command for a moved tab follows it

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src-tauri/src/ai_socket.rs src-tauri/src/lib.rs
```

---

## Task 3: What the carousel shows, and «Перейти»

**Files:**
- Modify: `src-tauri/src/routing.rs` (after `windows_now` l.153–160; tests)
- Modify: `src-tauri/src/tab_commands.rs` (after `tab_move`)
- Modify: `src-tauri/src/window.rs` (after `reveal_window` l.671–677)
- Modify: `src-tauri/src/lib.rs` (register two commands)

- [ ] **Step 1: Failing tests (`routing.rs` tests)**

```rust
    #[test]
    fn the_carousel_offers_every_other_live_window_the_most_recently_focused_first() {
        let mut reg = TabRegistry::new();
        for (label, id) in [("main", "m"), ("editor-2", "a"), ("editor-3", "b"), ("editor-4", "c"), ("editor-5", "d")] {
            reg.add_tab(label, id, None);
        }
        let order = vec!["editor-3".to_string(), "main".to_string(), "editor-5".to_string()];
        let rows = carousel_rows(&reg, &order, "main", |l| l != "editor-5");
        assert_eq!(
            rows.iter().map(|r| r.label.as_str()).collect::<Vec<_>>(),
            vec!["editor-3", "editor-2", "editor-4"],
            "focused before never focused; the caller and a dead window are not offered"
        );
    }

    #[test]
    fn a_carousel_row_names_the_windows_active_tab() {
        let mut reg = TabRegistry::new();
        reg.add_tab("editor-2", "a", Some("/p/a.md".into()));
        reg.add_tab("editor-2", "b", Some("/p/b.md".into()));
        reg.set_active("editor-2", "b");
        reg.set_number("editor-2", Some(7));
        reg.bind_project("editor-2", "/p".into());
        reg.add_tab("editor-3", "u", None);
        let rows = carousel_rows(&reg, &[], "main", |_| true);
        assert_eq!(
            rows[0],
            CarouselRow {
                label: "editor-2".into(),
                number: Some(7),
                project: Some("p".into()),
                tab_count: 2,
                active_path: Some("/p/b.md".into()),
                active_untitled: None,
            }
        );
        assert_eq!(rows[1].active_untitled.as_deref(), Some("u"));
        assert_eq!(rows[1].project, None);
    }

    #[test]
    fn a_thumbnail_head_is_whole_lines_within_its_budget() {
        assert_eq!(cut_head("short", 100), "short");
        assert_eq!(cut_head("one\ntwo\nthree", 9), "one\ntwo");
        assert_eq!(cut_head("жжжж", 3), "ж", "never inside a character");
    }
```

- [ ] **Step 2: Implement (`routing.rs`)**

After `windows_now`:

```rust
/// One window the carousel offers (plan 05), before its text is read —
/// that happens outside the registry lock.
#[derive(Debug, PartialEq, Eq)]
pub struct CarouselRow {
    pub label: String,
    pub number: Option<u32>,
    /// The project's directory name; `None` for a window that never held a file.
    pub project: Option<String>,
    pub tab_count: usize,
    pub active_path: Option<String>,
    /// The active tab's id when it is untitled: its text is in its sidecar.
    pub active_untitled: Option<String>,
}

/// The windows `caller`'s tabs can move to: every other live one, the most
/// recently focused first (`focus_order`, from `FocusTracker`), windows
/// never focused after them in label order (D8).
pub fn carousel_rows(
    reg: &TabRegistry,
    focus_order: &[String],
    caller: &str,
    is_live: impl Fn(&str) -> bool,
) -> Vec<CarouselRow> {
    let rank = |label: &str| focus_order.iter().position(|l| l == label).unwrap_or(usize::MAX);
    let mut rows: Vec<((usize, (u8, u32)), CarouselRow)> = reg
        .all_windows()
        .filter(|(label, _)| label.as_str() != caller && is_live(label))
        .map(|(label, w)| {
            let active = w.active.as_deref().and_then(|a| w.tabs.iter().find(|t| t.id == a));
            let row = CarouselRow {
                label: label.clone(),
                number: w.number,
                project: w.project.as_deref().map(|p| crate::git_info::dir_name(Path::new(p))),
                tab_count: w.tabs.len(),
                active_path: active.and_then(|t| t.path.clone()),
                active_untitled: active.filter(|t| t.path.is_none()).map(|t| t.id.clone()),
            };
            ((rank(label), crate::session::label_order(label)), row)
        })
        .collect();
    rows.sort_by_key(|(key, _)| *key);
    rows.into_iter().map(|(_, row)| row).collect()
}

/// At most `max` bytes of `text`, cut back to the last line end so that no
/// line is shown half — never inside a character.
pub fn cut_head(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let cut = &text[..end];
    cut.rfind('\n').map_or(cut, |i| &cut[..i]).to_string()
}
```

- [ ] **Step 3: Implement the two commands**

`src-tauri/src/tab_commands.rs`, after `tab_move`:

```rust
/// How much of a window's active document its thumbnail gets.
const HEAD_BYTES: usize = 2048;

/// One carousel thumbnail (D8) — `CarouselWindow` in `lib/tabs/carousel.ts`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarouselWindow {
    pub label: String,
    pub number: Option<u32>,
    pub project: Option<String>,
    /// The active file's branch; `None` outside git or for an untitled tab.
    pub branch: Option<String>,
    pub tab_count: usize,
    pub active_path: Option<String>,
    /// The start of the active document, whole lines, at most `HEAD_BYTES`.
    pub head: String,
}

/// The first bytes of a file — a little more than `HEAD_BYTES`, for the cut.
/// Empty when it cannot be read: a thumbnail is not worth an error.
fn read_start(path: &std::path::Path) -> String {
    use std::io::Read;
    let mut buf = Vec::with_capacity(HEAD_BYTES + 4);
    match std::fs::File::open(path) {
        Ok(file) => {
            let _ = file.take((HEAD_BYTES + 4) as u64).read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        }
        Err(_) => String::new(),
    }
}

/// IPC: the windows the caller's tabs can move to, for its carousel.
#[tauri::command]
pub async fn tab_carousel_windows(app: AppHandle, window: tauri::WebviewWindow) -> Result<Vec<CarouselWindow>, String> {
    // Before the registry lock: binding walks the file system.
    crate::routing::bind_missing_projects(&app);
    let order = app.state::<crate::menu_route::FocusTracker>().order();
    let rows = {
        let open_files = app.state::<OpenFiles>();
        let reg = open_files.0.lock().unwrap();
        crate::routing::carousel_rows(&reg, &order, window.label(), live_windows(&app))
    };
    let session = app.state::<SessionState>();
    Ok(rows
        .into_iter()
        .map(|row| {
            let text = match (&row.active_path, &row.active_untitled) {
                (Some(path), _) => read_start(std::path::Path::new(path)),
                (None, Some(id)) => session
                    .snapshot_for(&row.label)
                    .and_then(|w| w.tabs.into_iter().find(|t| &t.tab_id == id))
                    .and_then(|t| t.untitled)
                    .and_then(|name| crate::session::read_untitled(&name))
                    .unwrap_or_default(),
                (None, None) => String::new(),
            };
            let branch = row
                .active_path
                .as_deref()
                .and_then(|p| crate::git_info::git_info(std::path::Path::new(p)))
                .and_then(|g| g.branch);
            CarouselWindow {
                label: row.label,
                number: row.number,
                project: row.project,
                branch,
                tab_count: row.tab_count,
                active_path: row.active_path,
                head: crate::routing::cut_head(&text, HEAD_BYTES),
            }
        })
        .collect())
}
```

`src-tauri/src/window.rs`, after `reveal_window`:

```rust
/// IPC: bring window `label` forward — «Перейти» on the toast after a move
/// (plan 05, D5). Unminimizes it, gives it key focus, activates the app.
#[tauri::command]
pub async fn reveal_other_window(app: AppHandle, label: String) -> Result<(), String> {
    let win = app.get_webview_window(&label).ok_or_else(|| format!("no window {label}"))?;
    reveal(&win);
    win.run_on_main_thread(activate_app).map_err(|e| e.to_string())
}
```

Register in `lib.rs`: `tab_commands::tab_carousel_windows,` after `tab_commands::tab_move,`, and `window::reveal_other_window,` after `window::reveal_window,`.

- [ ] **Step 4: Run**

Run: `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result"` → `580 passed; 0 failed; 3 ignored`. Clippy → `50 warnings`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/routing.rs src-tauri/src/tab_commands.rs src-tauri/src/window.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(tabs): the carousel's windows (MRU, head of the active document) and reveal_other_window

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src-tauri/src/routing.rs src-tauri/src/tab_commands.rs src-tauri/src/window.rs src-tauri/src/lib.rs
```

---

## Task 4: `removeTabs` — a group leaves, the neighbour rule holds

**Files:**
- Modify: `src/lib/tabs/tab-model.ts` (after `removeTab` l.77–92)
- Test: `src/lib/tabs/tab-model.test.ts`

- [ ] **Step 1: Failing tests**

Add `removeTabs` to the import list, and append:

```ts
describe('removeTabs', () => {
  it('AnActiveTabThatStaysStaysActive', () => {
    const { state, nextActiveId } = removeTabs(list(['a', 'b', 'c'], 'a'), ['b']);
    expect(state.tabs.map((t) => t.id)).toEqual(['a', 'c']);
    expect(nextActiveId).toBe('a');
  });

  it('TheActiveOneGoing_TheFirstRemainingTabToItsRightTakesOver', () => {
    const { state } = removeTabs(list(['a', 'b', 'c', 'd'], 'b'), ['b', 'c']);
    expect(state.activeId).toBe('d');
  });

  it('…ElseTheNearestOneToItsLeft', () => {
    const { state } = removeTabs(list(['a', 'b', 'c'], 'c'), ['b', 'c']);
    expect(state).toEqual(list(['a'], 'a'));
  });

  it('EverythingGoing_NothingIsActive', () => {
    expect(removeTabs(list(['a', 'b'], 'a'), ['b', 'a'])).toEqual({ state: list([], null), nextActiveId: null });
  });
});
```

Run: `npx vitest run src/lib/tabs/tab-model.test.ts` → FAIL (`removeTabs is not a function`).

- [ ] **Step 2: Implement**

After `removeTab`:

```ts
/**
 * Remove every tab of `ids` — a group moving to another window. When the
 * active tab goes, the first remaining tab to its right becomes active, else
 * the nearest to its left: `removeTab`'s rule for a block.
 */
export function removeTabs(
  s: TabListState,
  ids: readonly string[]
): { state: TabListState; nextActiveId: string | null } {
  const gone = new Set(ids);
  const tabs = s.tabs.filter((t) => !gone.has(t.id));
  if (s.activeId === null || !gone.has(s.activeId)) {
    return { state: { tabs, activeId: s.activeId }, nextActiveId: s.activeId };
  }
  const at = s.tabs.findIndex((t) => t.id === s.activeId);
  const right = s.tabs.slice(at + 1).find((t) => !gone.has(t.id));
  const left = s.tabs.slice(0, Math.max(at, 0)).reverse().find((t) => !gone.has(t.id));
  const nextActiveId = (right ?? left)?.id ?? null;
  return { state: { tabs, activeId: nextActiveId }, nextActiveId };
}
```

- [ ] **Step 3: Run**

Run: `npx vitest run src/lib/tabs/tab-model.test.ts` → PASS. `npx vitest run --dir src` → **84 files / 1773 tests**.

- [ ] **Step 4: Commit**

```bash
git add src/lib/tabs/tab-model.ts src/lib/tabs/tab-model.test.ts
git commit -m "$(cat <<'EOF'
feat(tabs): removeTabs — a group leaves, the neighbour takes over

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/tabs/tab-model.ts src/lib/tabs/tab-model.test.ts
```

---

## Task 5: The carousel's model, as pure functions

Everything the carousel decides — order, keyboard, edge speed, scale, reveal, when it is up — with its own tests; the component (Task 9) holds only the DOM and the frame loop. Numbers are the mockup's (`drawer-carousel.html` l.1329–1391).

**Files:**
- Create: `src/lib/tabs/carousel.ts`
- Test: `src/lib/tabs/carousel.test.ts`

- [ ] **Step 1: Failing tests**

`src/lib/tabs/carousel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  EDGE_SPEED_PX,
  REDUCED_STEP_MS,
  carouselItems,
  carouselKey,
  clampOffset,
  edgeVelocity,
  glide,
  initialKb,
  moveKbIndex,
  reducedStep,
  revealOffset,
  targetOf,
  thumbScale,
  thumbWidth,
  wantsCarousel,
  type CarouselWindow,
} from './carousel';

const win = (label: string, number: number): CarouselWindow => ({
  label,
  number,
  project: 'p',
  branch: null,
  tabCount: 1,
  activePath: `/p/${label}.md`,
  head: '',
});

const key = (k: string, mods: Partial<KeyboardEventInit & { keyCode: number }> = {}) => ({
  key: k,
  code: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('carousel items', () => {
  it('NewWindowComesFirst_ThenTheWindowsInTheOrderRustSent', () => {
    const items = carouselItems([win('editor-3', 12), win('editor-2', 7)]);
    expect(items.map((i) => (i.kind === 'new' ? 'new' : i.label))).toEqual(['new', 'editor-3', 'editor-2']);
  });

  it('AnItemNamesWhereTheTabsGo', () => {
    const [fresh, other] = carouselItems([win('editor-3', 12)]);
    expect(targetOf(fresh)).toEqual({ kind: 'new-window' });
    expect(targetOf(other)).toEqual({ kind: 'window', label: 'editor-3' });
  });

  it('TheKeyboardStartsOnTheLastFocusedWindow_OrOnNewWindowWhenThereIsNone', () => {
    expect(initialKb(carouselItems([win('editor-3', 12)]))).toBe(1);
    expect(initialKb(carouselItems([]))).toBe(0);
  });

  it('ArrowsStopAtTheEnds', () => {
    expect(moveKbIndex(0, -1, 3)).toBe(0);
    expect(moveKbIndex(1, 1, 3)).toBe(2);
    expect(moveKbIndex(2, 1, 3)).toBe(2);
    expect(moveKbIndex(0, 1, 0)).toBe(0);
  });
});

describe('carousel geometry', () => {
  it('AThumbnailFillsTheCarouselLessAGutter_Within190To320', () => {
    expect(thumbWidth(100)).toBe(190);
    expect(thumbWidth(300)).toBe(236);
    expect(thumbWidth(1000)).toBe(320);
  });

  it('TheEdgeZonesAreTheTopAndBottom22Percent', () => {
    expect(edgeVelocity(500, 0, 1000)).toBe(0);
    expect(edgeVelocity(0, 0, 1000)).toBe(-1);
    expect(edgeVelocity(1000, 0, 1000)).toBe(1);
    expect(edgeVelocity(110, 0, 1000)).toBeCloseTo(-0.5);
    expect(edgeVelocity(-50, 0, 1000)).toBe(-1);
  });

  it('TheGlideIsSlowNearTheZoneAndStopsAtTheEnds', () => {
    expect(glide(100, 0.5, 1000)).toBe(100 + 0.25 * EDGE_SPEED_PX);
    expect(glide(100, -1, 1000)).toBe(100 - EDGE_SPEED_PX);
    expect(glide(5, -1, 1000)).toBe(0);
    expect(glide(995, 1, 1000)).toBe(1000);
    expect(clampOffset(50, -10)).toBe(0);
  });

  it('WithReducedMotionTheEdgeStepsHalfAViewAtATime', () => {
    expect(reducedStep(0, 1, 1000, 400, 0, REDUCED_STEP_MS)).toEqual({ offset: 200, lastStepAt: REDUCED_STEP_MS });
    expect(reducedStep(200, 1, 1000, 400, 1000, 1000 + REDUCED_STEP_MS - 1)).toEqual({ offset: 200, lastStepAt: 1000 });
    expect(reducedStep(200, 0, 1000, 400, 0, 5000)).toEqual({ offset: 200, lastStepAt: 0 });
  });

  it('ThumbnailsShrinkTo88PercentAwayFromTheMiddle', () => {
    expect(thumbScale(500, 500, 400)).toBe(1);
    expect(thumbScale(900, 500, 400)).toBeCloseTo(0.88);
    expect(thumbScale(2000, 500, 400)).toBeCloseTo(0.88);
  });

  it('RevealScrollsOnlyAsFarAsNeeded', () => {
    expect(revealOffset(300, 100, 200, 400, 1000)).toBe(72);
    expect(revealOffset(0, 500, 600, 400, 1000)).toBe(228);
    expect(revealOffset(100, 150, 250, 400, 1000)).toBe(100);
  });

  it('IsUpOnlyOverThePageRightOfTheDrawer', () => {
    expect(wantsCarousel(500, 300, 420, 1000, 700)).toBe(true);
    expect(wantsCarousel(410, 300, 420, 1000, 700)).toBe(false);
    expect(wantsCarousel(500, 800, 420, 1000, 700)).toBe(false);
    expect(wantsCarousel(1000, 300, 420, 1000, 700)).toBe(false);
  });
});

describe('carousel keys', () => {
  it('ArrowsEnterAndEscape', () => {
    expect(carouselKey(key('ArrowUp'))).toBe('up');
    expect(carouselKey(key('ArrowDown'))).toBe('down');
    expect(carouselKey(key('Enter'))).toBe('choose');
    expect(carouselKey(key('Escape'))).toBe('cancel');
    expect(carouselKey(key('a'))).toBe('none');
  });

  it('NothingWithACommandKeyOrWhileTheImeComposes', () => {
    expect(carouselKey(key('Enter', { metaKey: true }))).toBe('none');
    expect(carouselKey(key('ArrowDown', { ctrlKey: true }))).toBe('none');
    expect(carouselKey(key('Enter', { isComposing: true }))).toBe('none');
    expect(carouselKey(key('Process', { keyCode: 229 }))).toBe('none');
  });
});
```

Run: `npx vitest run src/lib/tabs/carousel.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement**

`src/lib/tabs/carousel.ts`:

```ts
/**
 * The window carousel (plan 05; mockup drawer-carousel.html): what it offers,
 * where its keyboard goes, how its edges scroll. Pure — `WindowCarousel.svelte`
 * holds the DOM and the frame loop, `TabDrawer.svelte` the gesture.
 */
import type { KeyLike } from './drawer-state';

/** One window a tab can move to — `CarouselWindow` in src-tauri/src/tab_commands.rs. */
export interface CarouselWindow {
  label: string;
  number: number | null;
  project: string | null;
  branch: string | null;
  tabCount: number;
  activePath: string | null;
  /** The start of its active document. Untrusted text: rendered as text only. */
  head: string;
}

export type CarouselItem = { kind: 'new' } | ({ kind: 'window' } & CarouselWindow);

/** Where moved tabs go — `MoveTarget` in src-tauri/src/tab_commands.rs. */
export type MoveTarget = { kind: 'window'; label: string } | { kind: 'new-window' };

/** «+ Новое окно» first, then the windows in Rust's order (most recently focused first). */
export function carouselItems(windows: readonly CarouselWindow[]): CarouselItem[] {
  return [{ kind: 'new' }, ...windows.map((w) => ({ kind: 'window' as const, ...w }))];
}

export function targetOf(item: CarouselItem): MoveTarget {
  return item.kind === 'new' ? { kind: 'new-window' } : { kind: 'window', label: item.label };
}

/** The keyboard starts on the window the human was in last; alone, on «+ Новое окно». */
export function initialKb(items: readonly CarouselItem[]): number {
  return items.length > 1 ? 1 : 0;
}

export function moveKbIndex(index: number, delta: 1 | -1, count: number): number {
  return count === 0 ? 0 : Math.min(count - 1, Math.max(0, index + delta));
}

export const THUMB_MIN_PX = 190;
export const THUMB_MAX_PX = 320;
export const THUMB_GUTTER_PX = 64;
/** The width a thumbnail's document is laid out at before it is scaled down to the thumbnail. */
export const DOC_WIDTH_PX = 640;

export function thumbWidth(carouselWidth: number): number {
  return Math.round(Math.max(THUMB_MIN_PX, Math.min(THUMB_MAX_PX, carouselWidth - THUMB_GUTTER_PX)));
}

/** The top and bottom 22 % of the view scroll while the dragged card is in them. */
export const EDGE_ZONE = 0.22;
/** Pixels per frame at the very edge. */
export const EDGE_SPEED_PX = 16;
/** Reduced motion: the edge zone steps half a view this often instead of gliding (D11). */
export const REDUCED_STEP_MS = 400;
/** The «got it» pulse on a thumbnail before the carousel goes. */
export const GOT_MS = 420;

/** −1…1: how deep `y` is in the top (−) or bottom (+) edge zone of `top`…`bottom`; 0 between them. */
export function edgeVelocity(y: number, top: number, bottom: number): number {
  const zone = (bottom - top) * EDGE_ZONE;
  if (zone <= 0) return 0;
  let v = 0;
  if (y < top + zone) v = -(top + zone - y) / zone;
  else if (y > bottom - zone) v = (y - (bottom - zone)) / zone;
  return Math.max(-1, Math.min(1, v));
}

export function clampOffset(offset: number, max: number): number {
  return Math.max(0, Math.min(Math.max(0, max), offset));
}

/** One frame of the edge glide: slow at the zone's inner edge, fastest at the view's. */
export function glide(offset: number, v: number, max: number): number {
  return clampOffset(offset + v * Math.abs(v) * EDGE_SPEED_PX, max);
}

/** `glide` for reduced motion: half a view per `REDUCED_STEP_MS`, no frames in between. */
export function reducedStep(
  offset: number,
  v: number,
  max: number,
  viewHeight: number,
  lastStepAt: number,
  now: number
): { offset: number; lastStepAt: number } {
  if (v === 0 || now - lastStepAt < REDUCED_STEP_MS) return { offset, lastStepAt };
  return { offset: clampOffset(offset + (Math.sign(v) * viewHeight) / 2, max), lastStepAt: now };
}

/** Thumbnails shrink to 88 % as they leave the middle of the view. */
export function thumbScale(center: number, mid: number, half: number): number {
  if (half <= 0) return 1;
  return 1 - Math.min(1, Math.abs(center - mid) / half) * 0.12;
}

/** The offset that shows the item spanning `top`…`bottom` (track coordinates), `pad` around it. */
export function revealOffset(
  offset: number,
  top: number,
  bottom: number,
  viewHeight: number,
  max: number,
  pad = 28
): number {
  if (top - pad < offset) return clampOffset(top - pad, max);
  if (bottom + pad > offset + viewHeight) return clampOffset(bottom + pad - viewHeight, max);
  return offset;
}

/** Up while a dragged card is over the page right of the drawer, inside the window (D9). */
export function wantsCarousel(x: number, y: number, drawerRight: number, width: number, height: number): boolean {
  return x > drawerRight - 4 && x < width && y > 0 && y < height;
}

export type CarouselKey = 'up' | 'down' | 'choose' | 'cancel' | 'none';

/** The carousel's own keys (D10). Anything else: `none`. */
export function carouselKey(e: KeyLike): CarouselKey {
  if (e.isComposing || e.keyCode === 229) return 'none';
  if (e.metaKey || e.ctrlKey || e.altKey) return 'none';
  switch (e.key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'Enter':
      return 'choose';
    case 'Escape':
      return 'cancel';
    default:
      return 'none';
  }
}
```

- [ ] **Step 3: Run**

Run: `npx vitest run src/lib/tabs/carousel.test.ts` → 12 passed. `npx vitest run --dir src` → **85 files / 1785 tests**. `npm run check` → 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/tabs/carousel.ts src/lib/tabs/carousel.test.ts
git commit -m "$(cat <<'EOF'
feat(tabs): the window carousel's model — order, keys, edge glide, reveal

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/tabs/carousel.ts src/lib/tabs/carousel.test.ts
```

---

## Task 6: ⌘M — «В окно…» from the keyboard

**Files:**
- Modify: `src/lib/tabs/drawer-keys.ts` (after `DRAWER_SORT_KEYS` l.22–26)
- Modify: `src/lib/tabs/drawer-state.ts` (`DrawerKeyAction` l.187–194, `drawerKeyAction` l.206–224)
- Test: `src/lib/tabs/drawer-keys.test.ts`, `src/lib/tabs/drawer-state.test.ts`

- [ ] **Step 1: Failing tests**

`drawer-keys.test.ts` — import `DRAWER_MOVE_KEY` too, and add inside the `describe`:

```ts
  it('TheMoveKeyIsNobodysEither', () => {
    // ⌘M is «В окно…» only while the drawer is open (plan 05, D10).
    const native = new Set(NATIVE_MENU_ACCELERATORS.map((a) => a.accelerator));
    expect(native.has(DRAWER_MOVE_KEY.accelerator)).toBe(false);
    const claimed = [...readFileSync(MENU_RS, 'utf8').matchAll(/\.accelerator\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
    expect(claimed).not.toContain(DRAWER_MOVE_KEY.accelerator);
    expect(DRAWER_MOVE_KEY.accelerator).toBe(`CmdOrCtrl+${DRAWER_MOVE_KEY.code.slice(3)}`);
  });

  it('MenuRsHasNoPredefinedMinimize', () => {
    // A predefined Minimize item carries ⌘M without an `.accelerator("…")`
    // string, and would take the key before the webview sees it.
    expect(readFileSync(MENU_RS, 'utf8')).not.toMatch(/\.minimize\(|PredefinedMenuItem::minimize/);
  });
```

`drawer-state.test.ts`, inside `describe('drawerKeyAction', …)`:

```ts
  it('CmdMOpensTheCarousel', () => {
    expect(drawerKeyAction(key({ key: 'm', code: 'KeyM', metaKey: true }), '', true)).toEqual({ kind: 'carousel' });
    expect(drawerKeyAction(key({ key: 'm', code: 'KeyM', ctrlKey: true }), '', false)).toEqual({ kind: 'carousel' });
    // ⇧⌘M is the native AI-comment item and never reaches the webview.
    expect(drawerKeyAction(key({ key: 'M', code: 'KeyM', metaKey: true, shiftKey: true }), '', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(key({ key: 'm', code: 'KeyM' }), '', true)).toEqual({ kind: 'type', char: 'm' });
  });
```

Run: `npx vitest run src/lib/tabs/drawer-keys.test.ts src/lib/tabs/drawer-state.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`drawer-keys.ts`, after `DRAWER_SORT_KEYS`:

```ts
/**
 * «В окно…» (plan 05, D10): the carousel for the selection, else the card the
 * arrows are on, else the active tab. A drawer key like the sorts, for the
 * same reason — while the drawer is closed ⌘M is nobody's, and a native item
 * would fire whether the drawer is open or not.
 */
export const DRAWER_MOVE_KEY = { code: 'KeyM', accelerator: 'CmdOrCtrl+M' } as const;
```

`drawer-state.ts`: `import { DRAWER_MOVE_KEY, sortKindForCode } from './drawer-keys';`; add `| { kind: 'carousel' }` to `DrawerKeyAction`; in `drawerKeyAction` the command branch becomes:

```ts
  if (command && !e.shiftKey && !e.altKey) {
    if (e.code === DRAWER_MOVE_KEY.code) return { kind: 'carousel' };
    const sort = sortKindForCode(e.code);
    return sort ? { kind: 'sort', sort } : { kind: 'none' };
  }
```

(`actionAllowed` needs no change: the carousel, like typing, needs the drawer to have the keyboard.) In `TabDrawer.svelte`'s `onKeyDown` switch add a placeholder arm so the switch stays exhaustive until Task 10 fills it:

```ts
      case 'carousel':
        break;
```

- [ ] **Step 3: Run**

Run: `npx vitest run --dir src` → **85 files / 1788 tests**. `npm run check` → 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/tabs/drawer-keys.ts src/lib/tabs/drawer-state.ts src/lib/tabs/drawer-keys.test.ts src/lib/tabs/drawer-state.test.ts src/lib/tabs/TabDrawer.svelte
git commit -m "$(cat <<'EOF'
feat(tabs): ⌘M in the drawer asks for the window carousel

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/tabs/drawer-keys.ts src/lib/tabs/drawer-state.ts src/lib/tabs/drawer-keys.test.ts src/lib/tabs/drawer-state.test.ts src/lib/tabs/TabDrawer.svelte
```

---

## Task 7: The agent inbox travels; a late command follows its tab

**Files:**
- Modify: `src/lib/tabs/agent-commands.ts` (`AgentCommandDeps` l.74–118; `landBackground` l.252–284; `run` l.340–364; `closeFor` l.319–338; the returned object l.366–462)
- Modify: `src/App.svelte` (`createAgentCommands` deps, l.1621–1644)
- Test: `src/lib/tabs/agent-commands.test.ts`

- [ ] **Step 1: Failing tests**

In `makeWorld` (agent-commands.test.ts): next to `pendingFails`, add

```ts
  /** Requests Rust hands on to the window that holds their file now (`ai_forward`). */
  const forwards = new Set<number>();
  const forwardFails = new Set<number>();
```

in the `createAgentCommands({ … })` deps add

```ts
    forward: async (p) => {
      log.push(`forward ${p.id}`);
      if (forwardFails.has(p.id)) throw new Error('ipc down');
      return forwards.has(p.id);
    },
```

and return `forwards, forwardFails` from `makeWorld`. Then append:

```ts
describe('a tab that moved to another window (plan 05)', () => {
  it('ACommandForAFileAnotherWindowHoldsNowIsForwarded_NotAnswered', async () => {
    const w = makeWorld(['a'], 'a');
    w.tabs.openBackgroundNow = async () => ({ kind: 'other-window', label: 'editor-2' });
    w.forwards.add(1);
    await w.send(payload({ id: 1, cmd: 'ask', path: '/b.md' }));
    expect(w.log).toContain('forward 1');
    expect(w.response(1)).toBeUndefined();
  });

  it('WhenRustWillNotTakeIt_OrCannotBeAsked_TheAgentHearsWhy', async () => {
    const w = makeWorld(['a'], 'a');
    w.tabs.openBackgroundNow = async () => ({ kind: 'other-window', label: 'editor-2' });
    w.forwardFails.add(2);
    await w.send(payload({ id: 1, cmd: 'show', path: '/b.md', line: 1 }));
    await w.send(payload({ id: 2, cmd: 'show', path: '/b.md', line: 1 }));
    expect(w.response(1)).toEqual({ ok: false, error: AGENT_ERRORS.elsewhere });
    expect(w.response(2)).toEqual({ ok: false, error: AGENT_ERRORS.elsewhere });
  });

  it('ACloseForATabThatLeftIsForwardedToo', async () => {
    const w = makeWorld(['a'], 'a');
    w.forwards.add(3);
    await w.send(payload({ id: 3, cmd: 'close', path: '/gone.md' }));
    expect(w.log).toContain('forward 3');
    expect(w.response(3)).toBeUndefined();
  });

  it('CarryTakesWhatWaitsForTheTab_AndNothingIsLeftBehindOrAnswered', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 4, cmd: 'ask', path: '/b.md' }));
    const carried = w.agent.carry('b');
    expect(carried).toEqual([{ kind: 'ask', payload: expect.objectContaining({ id: 4 }), deadline: 1_000 + 300_000 }]);
    await w.click('b');
    expect(w.count('placed 4')).toBe(0);
    expect(w.response(4)).toBeUndefined();
  });

  it('AdoptedAsksAreShownWhenTheTabIsEntered_ExpiredOnesAreDropped', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    w.pending.add(5);
    w.pending.add(6);
    w.agent.adopt('b', [
      { kind: 'ask', payload: payload({ id: 5, cmd: 'ask', path: '/b.md' }), deadline: 2_000 },
      { kind: 'ask', payload: payload({ id: 6, cmd: 'ask', path: '/b.md' }), deadline: 900 },
    ]);
    await w.click('b');
    expect(w.count('placed 5')).toBe(1);
    expect(w.count('placed 6')).toBe(0);
  });
});
```

Run: `npx vitest run src/lib/tabs/agent-commands.test.ts` → FAIL (type error on `forward`, `carry is not a function`).

- [ ] **Step 2: Implement**

`AgentCommandDeps`, after `respond`:

```ts
  /**
   * The command's file is held by another window now — its tab moved there
   * (plan 05), or was claimed there meanwhile: Rust hands the request over
   * (`ai_forward`). `false`: it would not; this window answers. Rejects when
   * Rust cannot be asked.
   */
  forward(payload: AiCommandPayload): Promise<boolean>;
```

In `createAgentCommands`, after `park`:

```ts
  /** Forwarded, or else answered with `error` — never both, never neither. */
  async function elsewhere(payload: AiCommandPayload, error: string): Promise<void> {
    let forwarded = false;
    try {
      forwarded = await deps.forward(payload);
    } catch (err) {
      console.error('ai_forward failed:', err);
    }
    if (!forwarded) await respond(payload, { ok: false, error });
  }
```

Use it in the three places that tell an agent its file is not here:
- `landBackground`: `if (result.kind === 'other-window') return elsewhere(payload, AGENT_ERRORS.elsewhere);`
- `run`: `if (switched.kind === 'elsewhere') return elsewhere(payload, AGENT_ERRORS.elsewhere);`
- `closeFor`: `if (!tab) return elsewhere(payload, AGENT_ERRORS.notOpen);`

In the returned object, after `forget`:

```ts
    /**
     * `tabId` leaves for another window (plan 05): what waited for it goes
     * with it, untouched — the controller stashed it first, so its live
     * questions are in the inbox already. Nothing is answered: the agents
     * wait on — the target window now.
     */
    carry(tabId: string): InboxItem[] {
      for (const [id, record] of placed) {
        if (record.tabId === tabId) placed.delete(id);
      }
      return inbox.take(tabId);
    },

    /**
     * `tabId` arrived with what waited for it in its old window. Asks keep
     * their deadline — one clock, `Date.now()`, in every window — and those
     * already past it are dropped by `park`.
     */
    adopt(tabId: string, items: readonly InboxItem[]): void {
      for (const item of items) park(tabId, item);
    },
```

`App.svelte`, in the `createAgentCommands({ … })` deps after `respond`:

```ts
    forward: (payload) => invoke<boolean>('ai_forward', { payload }),
```

- [ ] **Step 3: Run**

Run: `npx vitest run src/lib/tabs/agent-commands.test.ts` → PASS. `npx vitest run --dir src` → **85 files / 1793 tests**. `npm run check` → 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/tabs/agent-commands.ts src/lib/tabs/agent-commands.test.ts src/App.svelte
git commit -m "$(cat <<'EOF'
feat(ai): the agent inbox travels with a moved tab; late commands follow it

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/tabs/agent-commands.ts src/lib/tabs/agent-commands.test.ts src/App.svelte
```

---

## Task 8: The controller moves tabs out and takes them in

The one path that changes what a window shows (CLAUDE.md, `controller.ts`) gets the move (D3), the arrival (D4) and a «В новые окна» on the same move (D7). `detachNow`/`adoptNow` and the release-then-open dance go.

**Files:**
- Modify: `src/lib/tabs/controller.ts`
- Modify: `src/lib/tabs/tab-name.ts` (`tabNames` l.10–13)
- Modify: `src/lib/tauri/commands.ts` (`PendingTab` l.74–85), `src/lib/tauri/events.ts` (after `onReopenTab`)
- Modify: `src/App.svelte` (controller deps l.554–602; `moveTabsToNewWindows` l.657–673; `onMount` listeners l.1745–1760 and cleanup l.2112–2113)
- Test: `src/lib/tabs/controller.test.ts`, `src/lib/tabs/tab-name.test.ts`

- [ ] **Step 1: The harness speaks the new deps (`controller.test.ts`)**

Imports: add `type MoveDone, type MovedTab` to the `./controller` import, and

```ts
import type { InboxItem } from './agent-inbox';
import type { MoveTarget } from './carousel';
```

In `makeHarness`: next to `parkOnLeave` add `const inboxes = new Map<string, InboxItem[]>();` and `let moveCount = 0;`. In `deps.ai` add

```ts
      carry: vi.fn((tabId: string): InboxItem[] => {
        calls.push(`carry ${tabId}`);
        return inboxes.get(tabId) ?? [];
      }),
      adopt: vi.fn((tabId: string, items: readonly InboxItem[]) => {
        calls.push(`adopt ${tabId} ${items.length}`);
      }),
```

In `deps.rust` replace `openWindow` with

```ts
      move: vi.fn(async (moving: MovedTab[], target: MoveTarget): Promise<MoveDone> => {
        calls.push(`move ${moving.map((t) => t.tabId).join(',')} → ${target.kind === 'window' ? target.label : 'new'}`);
        return { label: target.kind === 'window' ? target.label : `editor-${9 + moveCount++}`, number: 9 };
      }),
```

and return `inboxes` from the harness. Delete the `moveOut` helper, the 14 tests in `describe('drawer operations')` from `DetachTabsReleasesInsteadOfClosing` through `AStrandedTabSomeoneElseClaimedMeanwhileIsNotAddedTwice`, and `ATabMovedToAnotherWindowIsForgottenAndReleased` in `describe('agent hooks')` — the release-based "to new windows" they pin is gone.

- [ ] **Step 2: Failing tests**

Append to `controller.test.ts`:

```ts
describe('moving tabs to another window (plan 05)', () => {
  const files = { '/a.md': 'AAAA', '/b.md': 'BBBB', '/c.md': 'CCCC', '/d.md': 'DDDD' };
  const three = () => [fileTab('a', '/a.md'), fileTab('b', '/b.md'), fileTab('c', '/c.md')];
  const to2: MoveTarget = { kind: 'window', label: 'editor-2' };
  const sent = (h: Harness) => vi.mocked(h.deps.rust.move).mock.calls.map(([tabs]) => tabs);
  const pulse = { kind: 'pulse', payload: { id: 9 } } as unknown as InboxItem;

  it('MovesABackgroundTab_TheActiveStays_NothingIsReleasedOrClosed', async () => {
    const h = await started(files, three());
    expect(await h.controller.moveTabs(['b'], to2)).toEqual({ kind: 'moved', label: 'editor-2', number: 9, count: 1 });
    expect(h.ids()).toEqual(['a', 'c']);
    expect(h.active()).toBe('a');
    expect(h.deps.rust.release).not.toHaveBeenCalled();
    expect(h.deps.rust.close).not.toHaveBeenCalled();
    expect(h.deps.ai.forget).not.toHaveBeenCalled();
    expect(h.deps.settled).toHaveBeenCalled();
  });

  it('AGroupGoesInThisWindowsOrder', async () => {
    const h = await started(files, [...three(), fileTab('d', '/d.md')]);
    await h.controller.moveTabs(['d', 'b'], to2);
    expect(sent(h)[0].map((t) => t.tabId)).toEqual(['b', 'd']);
    expect(h.ids()).toEqual(['a', 'c']);
  });

  it('MovingTheActiveTabShowsItsRightNeighbourBeforeTheMoveIsSent', async () => {
    const h = await started(files, three());
    await h.controller.moveTabs(['a'], to2);
    expect(h.active()).toBe('b');
    expect(h.live().doc.toString()).toBe('BBBB');
    expect(h.calls.indexOf('swap')).toBeLessThan(h.calls.indexOf('move a → editor-2'));
    expect(h.calls.indexOf('move a → editor-2')).toBeLessThan(h.calls.indexOf('activate b'));
    expect(h.deps.comments.commitPauses).toHaveBeenCalledWith('/a.md');
  });

  it('AnUntitledTabGoesWithItsText_TheActiveOneWithWhatWasJustTyped', async () => {
    const h = await started(files, [untitledTab('u'), untitledTab('v', 'draft'), fileTab('b', '/b.md')]);
    h.type('typed');
    await h.controller.moveTabs(['v', 'u'], to2);
    expect(sent(h)[0].map((t) => [t.tabId, t.content])).toEqual([
      ['u', 'typed'],
      ['v', 'draft'],
    ]);
    expect(h.ids()).toEqual(['b']);
  });

  it('StampsCaretAndQuickLookGoWithIt', async () => {
    const b: InitTab = {
      ...fileTab('b', '/b.md'),
      cursor: 3,
      topLine: 2,
      openedAt: 50,
      viewedAt: 60,
      unviewed: true,
      transient: true,
      transientSeenAt: 70,
    };
    const h = await started(files, [fileTab('a', '/a.md'), b]);
    await h.controller.moveTabs(['b'], to2);
    expect(sent(h)[0]).toEqual([
      {
        tabId: 'b',
        content: null,
        cursor: 3,
        topLine: 2,
        openedAt: 50,
        viewedAt: 60,
        unviewed: true,
        transient: true,
        transientSeenAt: 70,
        inbox: [],
      },
    ]);
  });

  it('WhatWaitedForTheTabGoesWithIt', async () => {
    const h = await started(files, three());
    h.inboxes.set('b', [pulse]);
    await h.controller.moveTabs(['b'], to2);
    expect(sent(h)[0][0].inbox).toEqual([pulse]);
    expect(h.calls).toContain('carry b');
  });

  it('AnActiveFileTabWhoseSaveDidNotLandIsRefused_NothingMoves', async () => {
    const h = await started(files, three());
    h.setSaveSucceeds(false);
    h.type('unsaved');
    expect(await h.controller.moveTabs(['a', 'b'], to2)).toEqual({ kind: 'refused' });
    expect(h.deps.reportUnsaved).toHaveBeenCalledTimes(1);
    expect(h.deps.rust.move).not.toHaveBeenCalled();
    expect(h.ids()).toEqual(['a', 'b', 'c']);
    expect(h.live().doc.toString()).toBe('AAAAunsaved');
  });

  it('ASaveErrorRefusesTheMove', async () => {
    const h = await started(files, three());
    vi.mocked(h.deps.saveErrorPending).mockReturnValue(true);
    expect(await h.controller.moveTabs(['a'], to2)).toEqual({ kind: 'refused' });
    expect(h.deps.rust.move).not.toHaveBeenCalled();
  });

  it('MovingEveryTabClosesTheWindowAfterTheMove', async () => {
    const h = await started(files, three());
    const outcome = await h.controller.moveTabs(['c', 'a', 'b'], { kind: 'new-window' });
    expect(outcome).toEqual({ kind: 'moved', label: 'editor-9', number: 9, count: 3 });
    expect(h.calls.indexOf('move a,b,c → new')).toBeLessThan(h.calls.indexOf('closeWindow'));
    expect(h.live().doc.toString()).toBe('');
    expect(h.ids()).toEqual([]);
  });

  it('AFailedMovePutsTheTabsBackWhereTheyStood', async () => {
    const h = await started(files, three());
    h.inboxes.set('b', [pulse]);
    vi.mocked(h.deps.rust.move).mockRejectedValueOnce(new Error('window editor-2 is gone'));
    expect(await h.controller.moveTabs(['b'], to2)).toEqual({ kind: 'failed', error: 'window editor-2 is gone' });
    expect(h.ids()).toEqual(['a', 'b', 'c']);
    expect(h.active()).toBe('a');
    expect(h.calls).toContain('adopt b 1');
  });

  it('AFailedMoveOfTheWholeWindowShowsItsTabAgain', async () => {
    const h = await started(files, three());
    vi.mocked(h.deps.rust.move).mockRejectedValueOnce(new Error('no'));
    await h.controller.moveTabs(['a', 'b', 'c'], { kind: 'new-window' });
    expect(h.ids()).toEqual(['a', 'b', 'c']);
    expect(h.active()).toBe('a');
    expect(h.live().doc.toString()).toBe('AAAA');
    expect(h.deps.rust.closeWindow).not.toHaveBeenCalled();
  });

  it('MoveToNewWindowsSendsEachTabToAWindowOfItsOwn_InListOrder', async () => {
    const h = await started(files, three());
    const outcome = await h.controller.moveToNewWindows(['c', 'a']);
    expect(h.calls.filter((c) => c.startsWith('move '))).toEqual(['move a → new', 'move c → new']);
    expect(outcome?.moved.map((m) => m.label)).toEqual(['editor-9', 'editor-10']);
    expect(outcome?.stranded).toEqual([]);
    expect(h.ids()).toEqual(['b']);
  });

  it('MoveToNewWindowsReportsWhatStayed', async () => {
    const h = await started(files, three());
    vi.mocked(h.deps.rust.move)
      .mockResolvedValueOnce({ label: 'editor-9', number: 9 })
      .mockRejectedValueOnce(new Error('no'));
    const outcome = await h.controller.moveToNewWindows(['b', 'c']);
    expect(outcome?.stranded).toEqual([{ path: '/c.md', error: 'no' }]);
    expect(h.ids()).toEqual(['a', 'c']);
  });
});

describe('tabs arriving from another window (plan 05)', () => {
  const files = { '/a.md': 'AAAA', '/b.md': 'BBBB', '/c.md': 'CCCC', '/x.md': 'XXXX' };
  const three = () => [fileTab('a', '/a.md'), fileTab('b', '/b.md'), fileTab('c', '/c.md')];
  const meta = (h: Harness, id: string) => h.controller.list.tabs.find((t) => t.id === id);
  const ask = { kind: 'ask', payload: { id: 4 }, deadline: 9_999_999 } as unknown as InboxItem;

  it('ArrivalsGoRightAfterTheActiveTab_InOrder_AndTheFirstIsShown', async () => {
    const h = await started(files, three());
    h.clock.focused = false;
    await h.controller.arrive([fileTab('x', '/x.md'), untitledTab('y', 'note')]);
    expect(h.ids()).toEqual(['a', 'x', 'y', 'b', 'c']);
    expect(h.active()).toBe('x');
    expect(h.live().doc.toString()).toBe('XXXX');
    expect(h.deps.rust.activate).toHaveBeenCalledWith('x');
    expect(h.deps.rust.open, 'Rust registered them already').not.toHaveBeenCalled();
    expect(meta(h, 'y')?.dirty, 'an untitled tab with text').toBe(true);
  });

  it('ArrivalsKeepTheirStampsAndQuickLook', async () => {
    const h = await started(files, three());
    h.clock.focused = false;
    await h.controller.arrive([
      { ...fileTab('x', '/x.md'), openedAt: 7, viewedAt: 8, unviewed: true, transient: true, transientSeenAt: 9 },
    ]);
    expect(meta(h, 'x')).toMatchObject({ openedAt: 7, viewedAt: 8, unviewed: true, transient: true, transientSeenAt: 9 });
  });

  it('WhatWaitedArrivesInTheInboxBeforeTheTabIsEntered', async () => {
    const h = await started(files, three());
    await h.controller.arrive([{ ...fileTab('x', '/x.md'), inbox: [ask] }]);
    expect(h.calls.indexOf('adopt x 1')).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('adopt x 1')).toBeLessThan(h.calls.indexOf('enter x'));
  });

  it('AWindowThatMayNotLeaveItsTabKeepsArrivalsInTheBackground_Quietly', async () => {
    const h = await started(files, three());
    h.setSaveSucceeds(false);
    h.type('unsaved');
    await h.controller.arrive([fileTab('x', '/x.md')]);
    expect(h.ids()).toEqual(['a', 'x', 'b', 'c']);
    expect(h.active()).toBe('a');
    expect(h.deps.reportUnsaved).not.toHaveBeenCalled();
    expect(h.deps.settled).toHaveBeenCalled();
  });

  it('ABlankUntitledGivesWayToArrivals', async () => {
    const h = await started(files, [untitledTab('u')]);
    await h.controller.arrive([fileTab('x', '/x.md')]);
    expect(h.ids()).toEqual(['x']);
    expect(h.calls).toContain('release u');
  });

  it('ANewWindowsInitCarriesQuickLookAndInbox', async () => {
    const h = makeHarness(files);
    await h.controller.init([{ ...fileTab('x', '/x.md'), transient: true, transientSeenAt: 5, inbox: [ask] }], 'x');
    expect(meta(h, 'x')).toMatchObject({ transient: true, transientSeenAt: 5 });
    expect(h.calls).toContain('adopt x 1');
  });

  it('AnArrivalThisWindowAlreadyHasIsIgnored', async () => {
    const h = await started(files, three());
    await h.controller.arrive([fileTab('b', '/b.md')]);
    expect(h.ids()).toEqual(['a', 'b', 'c']);
    expect(h.deps.rust.activate).not.toHaveBeenCalled();
  });
});
```

`tab-name.test.ts`, in `describe('tabNames')`:

```ts
  it('NamesAnUntitledTabToo', () => {
    expect(tabNames(['/a/x.md', null])).toBe('x.md, Untitled');
  });
```

Run: `npx vitest run src/lib/tabs/controller.test.ts src/lib/tabs/tab-name.test.ts` → FAIL (type errors: `move`, `carry`, `moveTabs`, `arrive`).

- [ ] **Step 3: Implement — types and deps (`controller.ts`)**

Imports: add `removeTabs` to the `./tab-model` list, and

```ts
import type { InboxItem } from './agent-inbox';
import type { MoveTarget } from './carousel';
```

`InitTab` gains, after `unviewed?`:

```ts
  /** A quick look carried by a move between windows (plan 05); absent for every other tab. */
  transient?: boolean;
  transientSeenAt?: number;
  /** What waited for the tab in its old window's agent inbox (plan 05). */
  inbox?: readonly InboxItem[];
```

After `TabReport`:

```ts
/** One tab as it leaves for another window — the shape `tab_move` takes (Rust `MovedTab`). */
export interface MovedTab {
  tabId: string;
  /** An untitled tab's text; `null` for a file tab — the target reads its file. */
  content: string | null;
  cursor: number;
  topLine: number;
  openedAt: number;
  viewedAt: number;
  unviewed: boolean;
  transient: boolean;
  transientSeenAt: number;
  inbox: InboxItem[];
}

/** `tab_move`'s answer: where the tabs are now. */
export interface MoveDone {
  label: string;
  number: number | null;
}

export type MoveOutcome =
  | { kind: 'moved'; label: string; number: number | null; count: number }
  /** The active tab may not be left (its save has not landed, or a save error stands); the toast says why. */
  | { kind: 'refused' }
  /** Rust refused or could not be asked; the tabs are back where they stood. */
  | { kind: 'failed'; error: string };

export interface NewWindowsOutcome {
  moved: MoveDone[];
  stranded: Stranded[];
}
```

`Stranded.path` becomes `path: string | null;` (an untitled tab can be stranded now) and its doc comment reads "A tab «В новые окна» left in this window: its move was refused, or failed." Delete `interface Detached`.

In `TabControllerDeps.ai`, after `forget`:

```ts
    /** `tabId` leaves for another window: what waits for it, taken out (`agent.carry`). */
    carry(tabId: string): InboxItem[];
    /** `tabId` arrived with what waited for it in its old window (`agent.adopt`). */
    adopt(tabId: string, items: readonly InboxItem[]): void;
```

In `TabControllerDeps.rust`, replace `openWindow` with:

```ts
    /** Move tabs of this window to `target` (Rust `tab_move`, atomic). Rejects when Rust refused. */
    move(tabs: MovedTab[], target: MoveTarget): Promise<MoveDone>;
```

- [ ] **Step 4: Implement — init and arrival**

Inside `createTabController`, after `newMeta`:

```ts
  function cacheFromInit(t: InitTab): TabCache {
    return { state: null, content: t.content, cursor: t.cursor, topLine: t.topLine, scroll: null, baseline: null, enterAt: null };
  }

  function metaFromInit(t: InitTab, now: number): TabMeta {
    return {
      id: t.tabId,
      path: t.path,
      dirty: t.path === null && (t.content ?? '') !== '',
      openedAt: t.openedAt || now,
      viewedAt: t.viewedAt ?? 0,
      unviewed: t.unviewed ?? false,
      ...(t.transient ? { transient: true, transientSeenAt: t.transientSeenAt ?? 0 } : {}),
    };
  }

  /** What waited for tabs that moved here, back into this window's inbox. */
  function adoptInboxes(tabs: readonly InitTab[]): void {
    for (const t of tabs) {
      if (t.inbox && t.inbox.length > 0) deps.ai.adopt(t.tabId, t.inbox);
    }
  }
```

In `initNow`, replace the cache loop and the `metas` map with:

```ts
    for (const t of tabs) cache.set(t.tabId, cacheFromInit(t));
    const now = deps.now();
    const metas: TabMeta[] = tabs.map((t) => metaFromInit(t, now));
    // A window built for a move (plan 05) is born with them.
    adoptInboxes(tabs);
```

After `initNow`:

```ts
  /**
   * Tabs another window moved here (plan 05, D4). Rust registered them to this
   * window already: never `tab_open`ed. They go right after the active tab, in
   * order; the first one is shown unless the active tab may not be left — then
   * they wait in the background, and no toast says so: the human is in the
   * other window. A blank Untitled gives way, as it does for an agent's open.
   */
  async function arriveNow(tabs: readonly InitTab[]): Promise<void> {
    const fresh = tabs.filter((t) => !findById(list, t.tabId));
    if (fresh.length === 0) return;
    const blank = isEmptyUntitled() ? list.activeId : null;
    const now = deps.now();
    const at = list.tabs.findIndex((t) => t.id === list.activeId);
    let next = list;
    fresh.forEach((t, k) => {
      cache.set(t.tabId, cacheFromInit(t));
      next = insertAt(next, at === -1 ? next.tabs.length : at + 1 + k, metaFromInit(t, now));
    });
    publish(next);
    adoptInboxes(fresh);
    const shown = await activateNow(fresh[0].tabId, { quiet: true });
    if (shown === 'ok' && blank !== null && blank !== fresh[0].tabId && findById(list, blank)) {
      await closeNow(blank, 'release');
      return;
    }
    if (shown !== 'ok') deps.settled();
  }
```

- [ ] **Step 5: Implement — the move out**

Delete `detachNow` and `adoptNow`. In their place:

```ts
  /** One tab as it leaves: what the target needs to show it as it was here (D2). */
  function outgoing(tab: TabMeta): MovedTab {
    const c = cache.get(tab.id);
    // Where an agent asked the caret to be on the next showing wins over where it was.
    const at = c?.enterAt ?? null;
    return {
      tabId: tab.id,
      content: tab.path === null ? (c?.state?.doc.toString() ?? c?.content ?? '') : null,
      cursor: at?.cursor ?? c?.cursor ?? 0,
      topLine: at?.topLine ?? c?.topLine ?? 1,
      openedAt: tab.openedAt,
      viewedAt: tab.viewedAt,
      unviewed: tab.unviewed,
      transient: tab.transient === true,
      transientSeenAt: tab.transientSeenAt ?? 0,
      inbox: deps.ai.carry(tab.id),
    };
  }

  /** Rust refused the move: the tabs come back where they stood, in the background, with what waited for them. */
  function putBack(before: TabListState, gone: readonly MovedTab[]): void {
    const ids = new Set(gone.map((g) => g.tabId));
    let back = list;
    for (const [index, tab] of before.tabs.entries()) {
      if (ids.has(tab.id) && !findById(back, tab.id)) back = insertAt(back, index, tab);
    }
    publish(back);
    for (const g of gone) {
      if (g.inbox.length > 0) deps.ai.adopt(g.tabId, g.inbox);
    }
  }

  /**
   * Move `ids` to another window (plan 05, D3): check → prepare → hand over →
   * swap → the one `await`, `tab_move` → settle. Nothing awaits between the
   * last dirty check and the swap, and the IPC comes after the swap: a key
   * typed meanwhile lands in the neighbour (or in a blank scratch state when
   * the window empties), never in a tab that is leaving. A move is neither a
   * close nor a release (D13): no `tab_close`/`tab_release`, and `ai.forget`
   * is not called — `outgoing` carries the inbox instead.
   */
  async function moveNow(ids: readonly string[], target: MoveTarget): Promise<MoveOutcome> {
    const wanted = new Set(ids);
    // This window's order, not the caller's: a group lands as it stood here (D7).
    const moving = list.tabs.filter((t) => wanted.has(t.id)).map((t) => t.id);
    if (moving.length === 0) return { kind: 'failed', error: 'no such tab' };
    const activeMoves = list.activeId !== null && wanted.has(list.activeId);
    let next: Loadable | null = null;
    if (activeMoves) {
      if (!(await mayLeave())) return { kind: 'refused' };
      next = await prepareLoadable(removeTabs(list, moving).state);
      if (!(await handOver())) return { kind: 'refused' };
      // The swap starts here; nothing awaits until the IPC below.
      stashActive();
    }
    const before = list;
    const leaving = moving.flatMap((id) => {
      const tab = findById(list, id);
      return tab ? [outgoing(tab)] : [];
    });
    const failed = next?.failed ?? [];
    for (const id of failed) cache.delete(id);
    publish(next ? next.working : removeTabs(list, moving).state);
    let entry: Entry | null = null;
    if (next?.tab) {
      entry = build(next.tab, next.ready, null);
      show(next.tab, entry);
    } else if (activeMoves) {
      // The window empties: nothing of the leaving tabs stays in the live view.
      deps.editor.swap(deps.editor.createState('', null), { blur: true, scroll: 'top' });
      deps.doc.setActive(null, false, null);
    }
    let done: MoveDone | null = null;
    let error = '';
    try {
      done = await deps.rust.move(leaving, target);
    } catch (err) {
      error = message(err);
    }
    await releaseAll(failed);
    if (done === null) {
      putBack(before, leaving);
      if (next?.tab && entry) await settle(next.tab, entry.restore, false);
      else if (list.activeId === null && before.activeId !== null) await activateNow(before.activeId, { quiet: true });
      deps.settled();
      return { kind: 'failed', error };
    }
    for (const id of moving) cache.delete(id);
    if (next?.tab && entry) await settle(next.tab, entry.restore, false);
    else deps.settled();
    // D6: an emptied window closes — after Rust holds its tabs elsewhere.
    if (list.tabs.length === 0) await deps.rust.closeWindow();
    return { kind: 'moved', label: done.label, number: done.number, count: leaving.length };
  }
```

In `closeNow`'s doc comment, replace "the tab moves to another window, so a release never closes this one" with "a blank Untitled that gave way to arrivals — so a release never closes this one".

- [ ] **Step 6: Implement — the API**

In the returned object, replace `moveToNewWindows` with:

```ts
    /** Move `ids` (in this window's order) to another window or a new one (plan 05). */
    moveTabs: (ids: readonly string[], target: MoveTarget) => queue.run(() => moveNow(ids, target)),
    /** Tabs another window moved here (`tabs-arrive`). */
    arrive: (tabs: readonly InitTab[]) => queue.run(() => arriveNow(tabs)),
    /**
     * «В новые окна» (spec §6, D7): each selected tab, in this window's order,
     * into a window of its own — the one move every move is. A tab whose move
     * was refused or failed stays here and is reported.
     */
    moveToNewWindows: (ids: readonly string[]) =>
      queue.run(async (): Promise<NewWindowsOutcome> => {
        const moved: MoveDone[] = [];
        const stranded: Stranded[] = [];
        for (const tab of list.tabs.filter((t) => ids.includes(t.id))) {
          const outcome = await moveNow([tab.id], { kind: 'new-window' });
          if (outcome.kind === 'moved') moved.push({ label: outcome.label, number: outcome.number });
          else stranded.push({ path: tab.path, error: outcome.kind === 'failed' ? outcome.error : null });
        }
        return { moved, stranded };
      }),
```

`tab-name.ts`: `export function tabNames(paths: readonly (string | null)[]): string` (the body is unchanged — `tabName` already names an untitled tab).

- [ ] **Step 7: The Tauri side of the frontend**

`src/lib/tauri/commands.ts`, `PendingTab` after `unviewed`:

```ts
  /** A quick look carried by a move between windows (plan 05); `false` otherwise. */
  transient: boolean;
  transientSeenAt: number;
  /** What waited for the tab in its old window's agent inbox; absent unless it moved. */
  inbox?: InboxItem[];
```

with `import type { InboxItem } from '../tabs/agent-inbox';` at the top.

`src/lib/tauri/events.ts`, after `onReopenTab` (add `import type { PendingTab } from './commands';`):

```ts
/**
 * Tabs another window moved here (plan 05, `tab_move`). Registered to this
 * window already: the controller shows them and never `tab_open`s them. Per
 * window, like `onAiCommand`; registered before `get_window_init` like every
 * other tab source (the window init contract).
 */
export function onTabsArrive(handler: (tabs: PendingTab[]) => void): Promise<() => void> {
  return getCurrentWebviewWindow().listen<PendingTab[]>('tabs-arrive', (event) => {
    handler(event.payload);
  });
}
```

- [ ] **Step 8: `App.svelte`**

Controller deps — in `ai`, after `forget`:

```ts
      carry: (tabId) => agent.carry(tabId),
      adopt: (tabId, items) => agent.adopt(tabId, items),
```

In `rust`, replace `openWindow` with:

```ts
      move: (moving, target) => invoke<MoveDone>('tab_move', { tabs: moving, target }),
```

(`import { createTabController, type MoveDone, type OpenAnswer, type Stranded } from './lib/tabs/controller';`.)

Replace `moveTabsToNewWindows` with:

```ts
  /** Tabs a move left in this window; say so, or the gesture looks like it did nothing. */
  function reportStranded(stranded: readonly Stranded[]): void {
    if (stranded.length === 0) return;
    // One toast for all of them: a toast replaces any other of its kind.
    const errors = [...new Set(stranded.flatMap(({ error }) => (error ? [error] : [])))];
    toasts.push({
      kind: 'tabs-stranded',
      fileNames: tabNames(stranded.map(({ path }) => path)),
      count: stranded.length,
      message: errors.length > 0 ? errors.join('; ') : null,
    });
  }

  /** «В новые окна» (spec §6). */
  async function moveTabsToNewWindows(tabIds: string[]): Promise<void> {
    const outcome = await tabs.moveToNewWindows(tabIds);
    if (outcome) reportStranded(outcome.stranded);
  }
```

In `onMount`, with the other tab sources, before the `Promise.all`:

```ts
    const unlistenTabsArrive = onTabsArrive((arrived) => {
      void tabSourcesReady.then(() => tabs.arrive(arrived));
    });
```

and make the `Promise.all` wait for it: `Promise.all([unlistenOpenFile, unlistenReopenTab, unlistenAiCommand, unlistenTabsArrive])`. In the cleanup, after `unlistenReopenTab.then((fn) => fn());`, add `unlistenTabsArrive.then((fn) => fn());`. Add `onTabsArrive` to the `./lib/tauri/events` import.

- [ ] **Step 9: Run**

Run: `npx vitest run src/lib/tabs/controller.test.ts src/lib/tabs/tab-name.test.ts` → PASS. `npx vitest run --dir src` → **85 files / 1799 tests** (+20 −15 in the controller, +1 in tab-name). `npm run check` → 0 errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/tabs/controller.ts src/lib/tabs/controller.test.ts src/lib/tabs/tab-name.ts src/lib/tabs/tab-name.test.ts src/lib/tauri/commands.ts src/lib/tauri/events.ts src/App.svelte
git commit -m "$(cat <<'EOF'
feat(tabs): the controller moves tabs out and takes them in; «В новые окна» on the same move

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/tabs/controller.ts src/lib/tabs/controller.test.ts src/lib/tabs/tab-name.ts src/lib/tabs/tab-name.test.ts src/lib/tauri/commands.ts src/lib/tauri/events.ts src/App.svelte
```

---

## Task 9: `WindowCarousel.svelte`

Presentational: the thumbnails, the listbox, the frame loop for the edge zones and the wheel. It never decides a move — `TabDrawer` (Task 10) owns the gesture, the keys and the pick. Markup and CSS are the mockup's `.carousel` block (`drawer-carousel.html` l.506–553, l.609–617, `renderCarousel` l.1333–1349), with its tokens renamed to the app's (`--brand-a` → `--tabs-brand-a`, `--shadow-rgb`/`--shadow-a` → `--tabs-shadow-rgb`/`--tabs-shadow-a`, `--ease` → `--tabs-ease`).

**Files:**
- Create: `src/lib/tabs/WindowCarousel.svelte`
- Test: `src/lib/tabs/WindowCarousel.svelte.test.ts`
- Modify: `locales/{ru,en,de,fr,es,zh}/app.json`

- [ ] **Step 1: Locale keys**

Add to every `locales/*/app.json`, next to the other `tabs.*` keys. Plural keys get all four forms in every file, as `tabs.drawer.count.*` does (`few`/`many` = `other` outside Russian).

| key | ru | en | de | fr | es | zh |
|---|---|---|---|---|---|---|
| `tabs.carousel.head` | Перенести {what} в окно | Move {what} to a window | {what} in ein Fenster verschieben | Déplacer {what} vers une fenêtre | Mover {what} a una ventana | 将{what}移到窗口 |
| `tabs.carousel.tabs.one` / `.few` / `.many` / `.other` | {count} вкладку / {count} вкладки / {count} вкладок / {count} вкладок | {count} tab / {count} tabs | {count} Tab / {count} Tabs | {count} onglet / {count} onglets | {count} pestaña / {count} pestañas | {count} 个标签页 |
| `tabs.carousel.windows.one` / `.few` / `.many` / `.other` | {count} окно / {count} окна / {count} окон / {count} окон | {count} window / {count} windows | {count} Fenster / {count} Fenster | {count} fenêtre / {count} fenêtres | {count} ventana / {count} ventanas | {count} 个窗口 |
| `tabs.carousel.new_window` | + Новое окно | + New window | + Neues Fenster | + Nouvelle fenêtre | + Ventana nueva | + 新窗口 |
| `tabs.carousel.new_window_short` | Новое окно | New window | Neues Fenster | Nouvelle fenêtre | Ventana nueva | 新窗口 |
| `tabs.carousel.drop_here` | сюда → #{n} | here → #{n} | hierher → #{n} | ici → #{n} | aquí → #{n} | 移到这里 → #{n} |
| `tabs.carousel.no_project` | без проекта | no project | kein Projekt | sans projet | sin proyecto | 无项目 |
| `tabs.carousel.more_up` | ▲ ещё окна | ▲ more windows | ▲ weitere Fenster | ▲ autres fenêtres | ▲ más ventanas | ▲ 更多窗口 |
| `tabs.carousel.more_down` | ▼ ещё окна | ▼ more windows | ▼ weitere Fenster | ▼ autres fenêtres | ▼ más ventanas | ▼ 更多窗口 |
| `tabs.carousel.foot_drag` | отпустите на окне · вернитесь в ящик — порядок · Esc — отмена | drop on a window · back to the drawer — reorder · Esc — cancel | auf einem Fenster loslassen · zurück in die Leiste — Reihenfolge · Esc — abbrechen | relâchez sur une fenêtre · retour au tiroir — ordre · Échap — annuler | suelte sobre una ventana · de vuelta al cajón — orden · Esc — cancelar | 在窗口上松开 · 拖回抽屉 — 排序 · Esc — 取消 |
| `tabs.carousel.foot_keys` | ↑↓ — выбрать · Enter — перенести · Esc — отмена | ↑↓ — choose · Enter — move · Esc — cancel | ↑↓ — wählen · Enter — verschieben · Esc — abbrechen | ↑↓ — choisir · Entrée — déplacer · Échap — annuler | ↑↓ — elegir · Enter — mover · Esc — cancelar | ↑↓ — 选择 · Enter — 移动 · Esc — 取消 |

Check every file still parses: `for f in locales/*/app.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || echo "BROKEN $f"; done` → no output.

- [ ] **Step 2: Failing component tests**

`src/lib/tabs/WindowCarousel.svelte.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import WindowCarousel, { type CarouselHandle } from './WindowCarousel.svelte';
import { carouselItems, type CarouselItem, type CarouselWindow } from './carousel';

const win = (label: string, number: number, head = '# Title\nline'): CarouselWindow => ({
  label,
  number,
  project: 'infra',
  branch: 'main',
  tabCount: 2,
  activePath: `/infra/${label}.md`,
  head,
});

let target: HTMLElement;
let component: ReturnType<typeof mount> | null = null;
let handle: CarouselHandle | undefined;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

function show(items: CarouselItem[] | null, extra: Partial<{ mode: 'drag' | 'keys'; kb: number; count: number }> = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  const onpick = vi.fn();
  component = mount(WindowCarousel, {
    target,
    props: {
      items,
      mode: extra.mode ?? 'drag',
      kb: extra.kb ?? 0,
      hot: null,
      got: null,
      left: 420,
      count: extra.count ?? 1,
      lead: 'plan.md',
      pointer: null,
      onpick,
      get handle() {
        return handle;
      },
      set handle(v: CarouselHandle | undefined) {
        handle = v;
      },
    },
  });
  flushSync();
  return { onpick };
}

const options = () => [...target.querySelectorAll<HTMLElement>('[role="option"]')];

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
});

describe('WindowCarousel', () => {
  it('ShowsNewWindowFirst_ThenTheWindowsInTheirOrder', () => {
    show(carouselItems([win('editor-3', 12), win('editor-2', 7)]));
    const opts = options();
    expect(opts.map((o) => o.textContent?.includes('#12') ?? false)).toEqual([false, true, false]);
    expect(opts[0].classList.contains('newwin')).toBe(true);
    expect(opts[2].querySelector('.wt-meta')?.textContent).toContain('#7');
    expect(target.querySelector('.car-head')?.textContent).toContain('plan.md');
  });

  it('WithASingleWindowOffersOnlyANewOne', () => {
    show(carouselItems([]));
    expect(options()).toHaveLength(1);
    expect(options()[0].classList.contains('newwin')).toBe(true);
  });

  it('IsAListboxWhoseActiveDescendantIsTheKeyboardsOption', () => {
    show(carouselItems([win('editor-3', 12), win('editor-2', 7)]), { mode: 'keys', kb: 2 });
    const box = target.querySelector<HTMLElement>('[role="listbox"]')!;
    const chosen = options()[2];
    expect(box.getAttribute('aria-activedescendant')).toBe(chosen.id);
    expect(chosen.getAttribute('aria-selected')).toBe('true');
    expect(options()[1].getAttribute('aria-selected')).toBe('false');
    handle!.focus();
    expect(document.activeElement).toBe(box);
  });

  it('AClickOnAThumbnailPicksIt_AndItemAtFindsTheOneUnderAPoint', () => {
    const { onpick } = show(carouselItems([win('editor-3', 12)]));
    options()[1].querySelector<HTMLElement>('.wt-page')!.click();
    expect(onpick).toHaveBeenCalledWith(1);
    const hit = options()[1].querySelector('.wt-meta')!;
    document.elementFromPoint = vi.fn(() => hit);
    expect(handle!.itemAt(10, 10)).toBe(1);
    document.elementFromPoint = vi.fn(() => document.body);
    expect(handle!.itemAt(10, 10)).toBeNull();
  });

  it('AThumbnailShowsItsTextAsText_NeverAsHtml', () => {
    show(carouselItems([win('editor-3', 12, '<img src=x onerror="alert(1)"> **bold**')]));
    expect(target.querySelector('img')).toBeNull();
    expect(options()[1].querySelector('.doc')?.textContent).toContain('<img');
  });
});
```

Run: `npx vitest run src/lib/tabs/WindowCarousel.svelte.test.ts` → FAIL (no such component).

- [ ] **Step 3: Implement**

`src/lib/tabs/WindowCarousel.svelte`:

```svelte
<script lang="ts">
  /**
   * The window carousel (plan 05; mockup drawer-carousel.html): the other
   * windows as thumbnails — «+ Новое окно» first — while a card is dragged
   * over the page or ⌘M asked for it. Presentational: `TabDrawer` feeds the
   * pointer, owns the keys and turns a pick into a move. Scrolling is written
   * straight to the DOM on each frame, never through reactive state.
   */
  import { tick } from 'svelte';
  import { plural, t } from '../i18n';
  import { previewLines, type InlineSeg } from './drawer-preview';
  import { tabName } from './tab-name';
  import {
    DOC_WIDTH_PX,
    clampOffset,
    edgeVelocity,
    glide,
    reducedStep,
    revealOffset,
    thumbScale,
    thumbWidth,
    type CarouselItem,
  } from './carousel';

  export interface CarouselHandle {
    /** Index of the item under a viewport point, `null` for none. */
    itemAt(x: number, y: number): number | null;
    /** Scroll item `index` into view — the keyboard's choice. */
    reveal(index: number): void;
    /** Give the listbox the keyboard (⌘M). */
    focus(): void;
  }

  let {
    items,
    mode,
    kb,
    hot,
    got,
    left,
    count,
    lead,
    pointer,
    onpick,
    onscroll,
    handle = $bindable(),
  }: {
    /** `null` while the windows are being fetched. */
    items: readonly CarouselItem[] | null;
    mode: 'drag' | 'keys';
    /** The keyboard's option (keys mode). */
    kb: number;
    /** The option under the dragged card. */
    hot: number | null;
    /** The option just picked: it pulses before the carousel goes. */
    got: number | null;
    /** The drawer's right edge, px: the carousel fills the page right of it. */
    left: number;
    /** How many tabs move. */
    count: number;
    /** The name of the (first) tab that moves. */
    lead: string;
    /** The dragged pointer, for the edge zones; `null` in keys mode. */
    pointer: { x: number; y: number } | null;
    onpick: (index: number) => void;
    /** The track moved under a still pointer: the drawer re-reads `itemAt`. */
    onscroll?: () => void;
    handle?: CarouselHandle;
  } = $props();

  let rootEl: HTMLDivElement | undefined = $state();
  let viewEl: HTMLDivElement | undefined = $state();
  let trackEl: HTMLDivElement | undefined = $state();
  let width = $state(0);
  let edges = $state({ top: false, bottom: false, v: 0 });
  // Per-frame state, written to the DOM directly.
  let offset = 0;
  let max = 0;
  let lastStepAt = 0;

  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tw = $derived(thumbWidth(width));
  const windowCount = $derived(Math.max(0, (items?.length ?? 1) - 1));
  const what = $derived(count > 1 ? plural(count, 'tabs.carousel.tabs') : lead);
  // The tab's name is bold in the mockup; the sentence stays one translation.
  const head = $derived(t('tabs.carousel.head').split('{what}'));
  const optionId = (i: number) => `car-opt-${i}`;
  const selectedIndex = $derived(mode === 'keys' ? kb : hot);

  function apply(v = edges.v): void {
    if (!trackEl || !viewEl) return;
    trackEl.style.transform = `translateY(${-offset}px)`;
    const r = viewEl.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    for (const el of Array.from(trackEl.children) as HTMLElement[]) {
      const b = el.getBoundingClientRect();
      el.style.setProperty('--s', thumbScale((b.top + b.bottom) / 2, mid, r.height / 2).toFixed(3));
    }
    const next = { top: offset > 2, bottom: offset < max - 2, v };
    if (next.top !== edges.top || next.bottom !== edges.bottom || next.v !== edges.v) edges = next;
  }

  function measure(): void {
    const last = trackEl?.lastElementChild as HTMLElement | null | undefined;
    max = last && viewEl ? Math.max(0, last.offsetTop + last.offsetHeight + 28 - viewEl.clientHeight) : 0;
    offset = clampOffset(offset, max);
    apply();
  }

  $effect(() => {
    const el = rootEl;
    if (!el) return;
    width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      width = el.clientWidth;
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  // A new list or a new size changes the scroll range.
  $effect(() => {
    void items;
    void tw;
    void tick().then(measure);
  });

  // The edge zones (D9): a frame loop while a card is dragged; `pointer` is
  // read inside the frame, so a move does not restart the loop.
  $effect(() => {
    if (mode !== 'drag') return;
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const p = pointer;
      const r = viewEl?.getBoundingClientRect();
      const v = p && r && p.x >= r.left && p.x <= r.right ? edgeVelocity(p.y, r.top, r.bottom) : 0;
      const before = offset;
      if (reduced) {
        const step = reducedStep(offset, v, max, r?.height ?? 0, lastStepAt, now);
        offset = step.offset;
        lastStepAt = step.lastStepAt;
      } else if (v !== 0) {
        offset = glide(offset, v, max);
      }
      if (offset !== before || v !== edges.v) {
        apply(v);
        if (offset !== before) onscroll?.();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  });

  // Not `onwheel`: Svelte attaches wheel listeners passive, and the page
  // behind must not scroll.
  $effect(() => {
    const el = viewEl;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      offset = clampOffset(offset + e.deltaY, max);
      apply();
      onscroll?.();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  $effect(() => {
    handle = {
      itemAt: (x, y) => {
        const el = document.elementFromPoint?.(x, y);
        const item = el instanceof Element ? el.closest<HTMLElement>('[data-carousel-item]') : null;
        return item && rootEl?.contains(item) ? Number(item.dataset.carouselItem) : null;
      },
      reveal: (index) => {
        const el = trackEl?.children[index] as HTMLElement | undefined;
        if (!el || !viewEl) return;
        offset = revealOffset(offset, el.offsetTop, el.offsetTop + el.offsetHeight, viewEl.clientHeight, max);
        apply();
      },
      focus: () => trackEl?.focus({ preventScroll: true }),
    };
  });

  /** One listener for every option: the listbox is the focusable element, options are not (aria-activedescendant). */
  function onTrackClick(e: MouseEvent): void {
    const item = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-carousel-item]') : null;
    if (item) onpick(Number(item.dataset.carouselItem));
  }
</script>

{#snippet segments(list: InlineSeg[])}
  {#each list as s, i (i)}{#if s.code}<code>{s.text}</code>{:else if s.bold}<strong>{s.text}</strong>{:else if s.italic}<em>{s.text}</em>{:else}{s.text}{/if}{/each}
{/snippet}

<div
  class="carousel"
  bind:this={rootEl}
  style:left="{left}px"
  style:--tw="{tw}px"
  style:--ts={(tw / DOC_WIDTH_PX).toFixed(4)}
>
  <div class="car-head">
    {head[0]}<b>{what}</b>{head[1] ?? ''} · {plural(windowCount, 'tabs.carousel.windows')}
  </div>
  <div class="car-view" bind:this={viewEl}>
    <div class="car-edge top" class:on={edges.top} class:hot={edges.v < 0}>{t('tabs.carousel.more_up')}</div>
    <!-- The listbox takes the keys through the drawer's capture handler (D10). -->
    <div
      class="car-track"
      role="listbox"
      tabindex="0"
      aria-label={t('tabs.carousel.head').replace('{what}', what)}
      aria-activedescendant={mode === 'keys' && items ? optionId(kb) : undefined}
      bind:this={trackEl}
      onclick={onTrackClick}
      onkeydown={() => {}}
    >
      {#each items ?? [] as item, i (item.kind === 'new' ? '+new' : item.label)}
        {#if item.kind === 'new'}
          <div
            class="wthumb newwin"
            role="option"
            id={optionId(i)}
            aria-selected={i === selectedIndex}
            data-carousel-item={i}
            class:hot={i === selectedIndex}
            class:got={i === got}
          >
            {t('tabs.carousel.new_window')}
          </div>
        {:else}
          <div
            class="wthumb"
            role="option"
            id={optionId(i)}
            aria-selected={i === selectedIndex}
            data-carousel-item={i}
            class:hot={i === selectedIndex}
            class:got={i === got}
          >
            <div class="wt-bar" aria-hidden="true">
              <i></i><i></i><i></i><span class="t">{tabName(item.activePath)}<span class="wid">— #{item.number ?? '?'}</span></span>
            </div>
            <div class="wt-page" aria-hidden="true">
              <div class="doc">
                {#each previewLines(item.head, 10) as line, j (j)}
                  {#if line.kind === 'heading'}<div class="h">{@render segments(line.segs)}</div>
                  {:else if line.kind === 'quote'}<blockquote>{@render segments(line.segs)}</blockquote>
                  {:else if line.kind === 'code'}<pre>{@render segments(line.segs)}</pre>
                  {:else}<p>{line.kind === 'task' ? (line.done ? '☑ ' : '☐ ') : line.kind === 'bullet' ? '• ' : ''}{@render segments(line.segs)}</p>
                  {/if}
                {/each}
              </div>
            </div>
            <div class="wt-meta">
              <b>#{item.number ?? '?'}</b><span>{item.project ?? t('tabs.carousel.no_project')}</span>
              {#if item.branch}<span class="br">⎇ {item.branch}</span>{/if}
              <span class="n">{plural(item.tabCount, 'tabs.drawer.count')}</span>
            </div>
            <div class="wt-drop" aria-hidden="true">{t('tabs.carousel.drop_here', { n: item.number ?? '?' })}</div>
          </div>
        {/if}
      {/each}
    </div>
    <div class="car-edge bot" class:on={edges.bottom} class:hot={edges.v > 0}>{t('tabs.carousel.more_down')}</div>
  </div>
  <div class="car-foot">{mode === 'keys' ? t('tabs.carousel.foot_keys') : t('tabs.carousel.foot_drag')}</div>
</div>

<style>
  /* Mockup `.carousel` (drawer-carousel.html l.510–553); fixed, because the
     drawer's root is `display: contents` and the page has no positioned box. */
  .carousel {
    position: fixed;
    top: 0;
    bottom: 0;
    right: 0;
    z-index: 950;
    display: flex;
    flex-direction: column;
    align-items: center;
    pointer-events: none;
    font-family: var(--tabs-ui);
    color: var(--text-primary);
    animation: car-in 0.22s ease;
  }
  .car-head {
    flex: 0 0 auto;
    margin-top: 16px;
    font-size: 11.5px;
    color: var(--text-muted);
    letter-spacing: 0.01em;
    text-align: center;
  }
  .car-head b {
    color: var(--text-primary);
    font-weight: 600;
  }
  .car-view {
    position: relative;
    flex: 1 1 auto;
    width: 100%;
    overflow: hidden;
    margin: 10px 0 14px;
    pointer-events: auto;
    -webkit-mask: linear-gradient(transparent 0, #000 9%, #000 91%, transparent 100%);
    mask: linear-gradient(transparent 0, #000 9%, #000 91%, transparent 100%);
  }
  .car-track {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    padding: 28px 0;
    will-change: transform;
    outline: none;
  }
  .wthumb {
    --s: 1;
    width: var(--tw);
    flex: 0 0 auto;
    border-radius: 10px;
    overflow: hidden;
    position: relative;
    cursor: pointer;
    background: var(--bg-base);
    transform: scale(var(--s));
    opacity: calc(0.45 + 0.55 * var(--s));
    box-shadow:
      0 0 0 0.5px rgba(0, 0, 0, 0.25),
      0 14px 34px rgba(var(--tabs-shadow-rgb), calc(var(--tabs-shadow-a) * 1.6));
    transition: box-shadow 0.15s ease, outline-color 0.15s ease;
    outline: 2px solid transparent;
    outline-offset: 2px;
  }
  :global(:root[data-theme$='dark']) .wthumb {
    box-shadow:
      0 0 0 0.5px rgba(0, 0, 0, 0.6),
      inset 0 0 0 0.5px rgba(255, 255, 255, 0.08),
      0 14px 34px rgba(0, 0, 0, 0.5);
  }
  .wthumb.hot {
    outline-color: var(--tabs-brand-a);
    box-shadow:
      0 0 0 0.5px rgba(0, 0, 0, 0.25),
      0 18px 44px rgba(var(--tabs-shadow-rgb), calc(var(--tabs-shadow-a) * 2.2));
  }
  .wt-bar {
    height: 22px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 9px;
    border-bottom: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
    font-size: 10.5px;
    color: var(--text-subtle);
  }
  .wt-bar i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: block;
    background: color-mix(in oklab, var(--text-muted) 45%, transparent);
  }
  .wt-bar .t {
    flex: 1;
    text-align: center;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-right: 26px;
  }
  .wt-bar .wid {
    color: var(--text-muted);
    font-weight: 500;
    margin-left: 4px;
  }
  .wt-page {
    height: calc(var(--tw) * 0.5);
    overflow: hidden;
    position: relative;
  }
  .doc {
    position: absolute;
    top: 0;
    left: 0;
    width: 640px;
    padding: 26px 34px;
    transform: scale(var(--ts));
    transform-origin: 0 0;
    font-family: var(--font-text);
    font-size: 16px;
    line-height: 1.7;
    color: var(--text-primary);
    pointer-events: none;
  }
  .doc .h {
    font-size: 1.7em;
    font-weight: 700;
    line-height: 1.25;
    margin: 0 0 0.4em;
  }
  .doc p,
  .doc blockquote,
  .doc pre {
    margin: 0 0 0.35em;
  }
  .doc blockquote {
    padding-left: 0.8em;
    border-left: 3px solid var(--border);
    color: var(--text-muted);
  }
  .doc pre,
  .doc :global(code) {
    font-family: var(--font-code);
    font-size: 0.88em;
  }
  .wt-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px 8px;
    border-top: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-surface);
  }
  .wt-meta b {
    font-family: var(--font-code);
    font-weight: 400;
    color: var(--text-primary);
  }
  .wt-meta .br {
    font-family: var(--font-code);
    font-size: 10.5px;
  }
  .wt-meta .n {
    margin-left: auto;
  }
  .wt-drop {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: color-mix(in oklab, var(--tabs-brand-a) 16%, transparent);
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 600;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .wthumb.hot .wt-drop {
    opacity: 1;
  }
  .wthumb.got {
    animation: got-it 0.5s var(--tabs-ease);
  }
  .wthumb.newwin {
    height: 64px;
    display: grid;
    place-items: center;
    background: transparent;
    border: 1.5px dashed color-mix(in oklab, var(--text-muted) 60%, transparent);
    box-shadow: none;
    font-size: 12.5px;
    color: var(--text-subtle);
  }
  .wthumb.newwin.hot {
    border-color: var(--tabs-brand-a);
    color: var(--text-primary);
    background: color-mix(in oklab, var(--tabs-brand-a) 10%, transparent);
  }
  .car-edge {
    position: absolute;
    left: 0;
    right: 0;
    height: 22%;
    display: flex;
    justify-content: center;
    font-size: 11px;
    color: var(--text-muted);
    opacity: 0;
    transition: opacity 0.15s;
    pointer-events: none;
    z-index: 1;
  }
  .car-edge.top {
    top: 0;
    align-items: flex-start;
    padding-top: 4px;
  }
  .car-edge.bot {
    bottom: 0;
    align-items: flex-end;
    padding-bottom: 4px;
  }
  .car-edge.on {
    opacity: 1;
  }
  .car-edge.hot {
    color: var(--text-primary);
  }
  .car-foot {
    flex: 0 0 auto;
    margin-bottom: 14px;
    font-size: 11px;
    color: var(--text-muted);
  }
  @keyframes car-in {
    from {
      opacity: 0;
    }
  }
  @keyframes got-it {
    0% {
      outline-color: var(--tabs-brand-a);
    }
    40% {
      transform: scale(calc(var(--s) * 1.04));
    }
    100% {
      transform: scale(var(--s));
    }
  }
  /* D11: nothing moves by itself. */
  @media (prefers-reduced-motion: reduce) {
    .carousel,
    .wthumb.got {
      animation: none;
    }
    .wthumb,
    .wt-drop,
    .car-edge {
      transition: none;
    }
  }
</style>
```

(The `onkeydown={() => {}}` keeps Svelte's a11y check quiet about a click handler without a key handler; the keys are the drawer's, D10.)

- [ ] **Step 4: Run**

Run: `npx vitest run src/lib/tabs/WindowCarousel.svelte.test.ts` → 5 passed. `npx vitest run --dir src` → **86 files / 1804 tests**. `npm run check` → 0 errors, no new warnings (if svelte-check flags `a11y_click_events_have_key_events` or `a11y_interactive_supports_focus` on the track, the fix is on the track element only — it is the focusable, interactive one; options stay without handlers).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tabs/WindowCarousel.svelte src/lib/tabs/WindowCarousel.svelte.test.ts locales/ru/app.json locales/en/app.json locales/de/app.json locales/fr/app.json locales/es/app.json locales/zh/app.json
git commit -m "$(cat <<'EOF'
feat(tabs): WindowCarousel — thumbnails, listbox, edge zones and wheel

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/tabs/WindowCarousel.svelte src/lib/tabs/WindowCarousel.svelte.test.ts locales/ru/app.json locales/en/app.json locales/de/app.json locales/fr/app.json locales/es/app.json locales/zh/app.json
```

---

## Task 10: The drawer drags out to the carousel and opens it from the keyboard

`TabDrawer` already has the pointer drag, the ghost (with the group counter) and the drop indicator (plan 03). It gains: the carousel while the dragged card is over the page (D9), the drop on a thumbnail, Esc to cancel, ⌘M and «В окно…» (D10), and the ghost's mockup bar («→ #N» / «Новое окно»). The page blur lives in `App.svelte` (the drawer only reports `oncarousel`).

**Files:**
- Modify: `src/lib/tabs/TabDrawer.svelte` (imports l.18–62; props l.76–103; state l.125–159; `closeDrawer` l.433–457; cleanup effect l.331–335; `onKeyDown` l.579–630; selection actions l.660–676; `beginDrag` l.787–797; `dragMove` l.804–817; `finishDrag` l.819–826; markup l.847–1018; styles)
- Modify: `src/App.svelte` (after `drawerSource` l.649–655; `<main>` and `<TabDrawer>` l.2282–2307; `main` style l.2342–2346)
- Modify: `locales/{ru,en,de,fr,es,zh}/app.json`
- Test: `src/lib/tabs/TabDrawer.svelte.test.ts`

- [ ] **Step 1: Locale key**

`tabs.selection.to_window` — ru `В окно…`, en `To a window…`, de `In ein Fenster…`, fr `Vers une fenêtre…`, es `A una ventana…`, zh `移到窗口…`. Check the six files parse (Task 9 Step 1's loop).

- [ ] **Step 2: Failing tests**

Harness (`TabDrawer.svelte.test.ts`): import `type CarouselWindow` from `./carousel`; add to `Harness` `windows: ReturnType<typeof vi.fn>; onmove: ReturnType<typeof vi.fn>; oncarousel: ReturnType<typeof vi.fn>;`; in `setup` create

```ts
  const windows = vi.fn(async (): Promise<CarouselWindow[]> => []);
  const onmove = vi.fn();
  const oncarousel = vi.fn();
```

pass `carouselSource: { windows: () => windows() }, onmove, oncarousel,` in `props`, and return them. In the file's `afterEach`, add `Reflect.deleteProperty(document, 'elementFromPoint');` (tests below stub it). Then append:

```ts
describe('TabDrawer — the window carousel (plan 05)', () => {
  const other = (label: string, number: number): CarouselWindow => ({
    label,
    number,
    project: 'p',
    branch: null,
    tabCount: 1,
    activePath: `/p/${label}.md`,
    head: '',
  });
  const page = () => h.root().parentElement!;
  const carousel = () => page().querySelector('.carousel');
  const option = (i: number) => page().querySelector<HTMLElement>(`[data-carousel-item="${i}"]`);
  const listbox = () => page().querySelector<HTMLElement>('[role="listbox"]');

  function shiftClick(id: string): void {
    pointer(card(id), 'pointerdown', { button: 0, shiftKey: true, clientX: 100, clientY: 100 });
    pointer(window, 'pointerup', { button: 0, clientX: 100, clientY: 100 });
  }

  /** Grab `id` and carry it onto the page, right of the (zero-width in jsdom) drawer. */
  async function dragOut(id: string): Promise<void> {
    pointer(card(id), 'pointerdown', { button: 0, buttons: 1, clientX: 10, clientY: 10 });
    pointer(window, 'pointermove', { buttons: 1, clientX: 600, clientY: 300 });
    await settle();
    await settle();
  }

  it('DraggingACardOntoThePageOpensTheCarousel_BackOverTheDrawerClosesIt', async () => {
    h.windows.mockResolvedValue([other('editor-2', 7)]);
    h.handle().toggle();
    await settle();
    await dragOut('b');
    expect(carousel()).not.toBeNull();
    expect(option(1)).not.toBeNull();
    expect(h.oncarousel).toHaveBeenLastCalledWith(true);
    pointer(window, 'pointermove', { buttons: 1, clientX: -10, clientY: 300 });
    await settle();
    expect(carousel()).toBeNull();
    expect(h.oncarousel).toHaveBeenLastCalledWith(false);
  });

  it('DroppingOnAThumbnailMovesTheDraggedTab', async () => {
    h.windows.mockResolvedValue([other('editor-2', 7)]);
    h.handle().toggle();
    await settle();
    await dragOut('b');
    document.elementFromPoint = vi.fn(() => option(1));
    pointer(window, 'pointermove', { buttons: 1, clientX: 610, clientY: 300 });
    await settle();
    expect(option(1)?.classList.contains('hot')).toBe(true);
    expect(page().querySelector('.ghost-bar span')?.textContent).toBe('→ #7');
    pointer(window, 'pointerup', { clientX: 610, clientY: 300 });
    await settle();
    expect(h.onmove).toHaveBeenCalledWith(['b'], { kind: 'window', label: 'editor-2' });
    expect(h.onreorder).not.toHaveBeenCalled();
  });

  it('DroppingOnNewWindowMovesTheGroupInListOrder_AsOneGhost', async () => {
    h.handle().toggle();
    await settle();
    shiftClick('d');
    shiftClick('b');
    await settle();
    await dragOut('d');
    expect(page().querySelectorAll('.ghost')).toHaveLength(1);
    expect(page().querySelector('.ghost-count')?.textContent).toBe('2');
    document.elementFromPoint = vi.fn(() => option(0));
    pointer(window, 'pointermove', { buttons: 1, clientX: 601, clientY: 300 });
    pointer(window, 'pointerup', { clientX: 601, clientY: 300 });
    await settle();
    expect(h.onmove).toHaveBeenCalledWith(['b', 'd'], { kind: 'new-window' });
  });

  it('EscCancelsADrag_NothingMoves_TheDrawerStaysOpen', async () => {
    h.handle().toggle();
    await settle();
    await dragOut('b');
    press('Escape');
    await settle();
    expect(page().querySelector('.ghost')).toBeNull();
    expect(carousel()).toBeNull();
    pointer(window, 'pointerup', { clientX: 600, clientY: 300 });
    expect(h.onmove).not.toHaveBeenCalled();
    expect(el('.drawer').hasAttribute('inert')).toBe(false);
  });

  it('CmdMOpensTheCarouselForTheSelection_ArrowsAndEnterMoveIt', async () => {
    h.windows.mockResolvedValue([other('editor-2', 7), other('editor-3', 8)]);
    h.handle().toggle();
    await settle();
    shiftClick('c');
    shiftClick('b');
    await settle();
    press('m', { metaKey: true, ctrlKey: true });
    await settle();
    await settle();
    expect(document.activeElement).toBe(listbox());
    expect(listbox()!.getAttribute('aria-activedescendant')).toBe(option(1)!.id);
    press('ArrowDown');
    await settle();
    expect(listbox()!.getAttribute('aria-activedescendant')).toBe(option(2)!.id);
    press('Enter');
    await settle();
    expect(h.onmove).toHaveBeenCalledWith(['b', 'c'], { kind: 'window', label: 'editor-3' });
  });

  it('CmdMWithoutASelectionMovesTheActiveTab_EscGivesTheKeysBackToTheList', async () => {
    h.handle().toggle();
    await settle();
    press('m', { metaKey: true, ctrlKey: true });
    await settle();
    await settle();
    // One window: only «+ Новое окно», and the keyboard is on it.
    expect(listbox()!.getAttribute('aria-activedescendant')).toBe(option(0)!.id);
    press('x');
    expect(query(), 'no key reaches the search behind the carousel').toBe('');
    press('Escape');
    await settle();
    expect(carousel()).toBeNull();
    expect(document.activeElement).toBe(el('.tab-list'));
    press('m', { metaKey: true, ctrlKey: true });
    await settle();
    await settle();
    press('Enter');
    await settle();
    expect(h.onmove).toHaveBeenCalledWith(['a'], { kind: 'new-window' });
  });
});
```

Run: `npx vitest run src/lib/tabs/TabDrawer.svelte.test.ts` → the new tests FAIL; the old ones still pass once the harness passes the new props (unknown props are ignored until Step 3).

- [ ] **Step 3: Implement — script**

Imports, added:

```ts
  import WindowCarousel, { type CarouselHandle } from './WindowCarousel.svelte';
  import {
    GOT_MS,
    carouselItems,
    carouselKey,
    initialKb,
    moveKbIndex,
    targetOf,
    wantsCarousel,
    type CarouselItem,
    type CarouselWindow,
    type MoveTarget,
  } from './carousel';
```

Props, after `onnewwindows`:

```ts
    carouselSource,
    onmove,
    oncarousel,
```

with their types after `onnewwindows: (tabIds: string[]) => void;`:

```ts
    /** The other windows, for the carousel (`tab_carousel_windows`). */
    carouselSource: { windows(): Promise<CarouselWindow[]> };
    /** Move `tabIds` — this window's order — to `target`: the carousel's drop or Enter. */
    onmove: (tabIds: string[], target: MoveTarget) => void;
    /** The carousel came up or went: the page behind it blurs. */
    oncarousel?: (on: boolean) => void;
```

State, after `let drag = $state<DragState | null>(null);`:

```ts
  interface CarouselState {
    mode: 'drag' | 'keys';
    /** The tabs that move, in list order. */
    ids: string[];
    /** The first one's name, taken when it opened: the tab leaves the list before the carousel does. */
    lead: string;
    /** `null` while fetching. */
    items: CarouselItem[] | null;
    kb: number;
    hot: number | null;
    got: number | null;
    left: number;
  }
  // `.raw`: always replaced whole, never mutated — and a deep proxy would make
  // its arrays compare unequal to the ones it was given.
  let car = $state.raw<CarouselState | null>(null);
  let carHandle: CarouselHandle | undefined = $state();
```

and with the bookkeeping:

```ts
  /** Fetched when a drag starts, so the thumbnails are there by the time the card reaches the page. */
  let windowsFetch: Promise<CarouselItem[]> | null = null;
  let carCloseTimer: ReturnType<typeof setTimeout> | undefined;
  /** Which opening a fetch belongs to: one that resolves after the carousel closed or reopened is dropped. */
  let carOpening = 0;
```

Effects — after the `handle` effect:

```ts
  $effect(() => {
    oncarousel?.(car !== null);
  });
```

and add `carCloseTimer` to the timers cleared in the unmount effect's list.

`closeDrawer`: after `endGesture?.();` add `closeCarousel();`.

`onKeyDown`: right after the IME check:

```ts
    // While ⌘M's carousel is up every key is its own (D10).
    if (car?.mode === 'keys') {
      onCarouselKey(e);
      return;
    }
    if (gesture === 'drag' && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      endGesture?.();
      return;
    }
```

and in the switch replace Task 6's placeholder with:

```ts
      case 'carousel':
        openMoveKeys();
        break;
```

After the selection actions (`moveSelected`):

```ts
  // --- the window carousel (plan 05) ---

  function fetchWindows(): Promise<CarouselItem[]> {
    return carouselSource.windows().then(carouselItems, () => carouselItems([]));
  }

  function openCarousel(mode: 'drag' | 'keys', ids: string[]): void {
    clearTimeout(carCloseTimer);
    const opened: CarouselState = {
      mode,
      ids,
      lead: tabName(byId.get(ids[0])?.path ?? null),
      items: null,
      kb: 0,
      hot: null,
      got: null,
      left: asideEl?.getBoundingClientRect().right ?? 0,
    };
    car = opened;
    const opening = ++carOpening;
    const fetching = windowsFetch ?? fetchWindows();
    windowsFetch = null;
    void fetching.then((items) => {
      if (!car || opening !== carOpening) return;
      car = { ...car, items, kb: initialKb(items) };
      if (mode === 'keys') void tick().then(() => carHandle?.focus());
      else refreshHot();
    });
  }

  function closeCarousel(): void {
    clearTimeout(carCloseTimer);
    car = null;
  }

  /** The option under the dragged card — also after the track scrolled under a still pointer. */
  function refreshHot(): void {
    const d = drag;
    if (!car || car.mode !== 'drag' || !d || car.got !== null) return;
    const hot = carHandle?.itemAt(d.x, d.y) ?? null;
    if (hot !== car.hot) car = { ...car, hot };
  }

  function pick(index: number): void {
    const c = car;
    const item = c?.items?.[index];
    if (!c || !item) return;
    onmove(c.ids, targetOf(item));
    ds = clearSelection(ds);
    car = { ...c, got: index, hot: null };
    carCloseTimer = setTimeout(closeCarousel, motion(GOT_MS));
    if (c.mode === 'keys') void tick().then(() => listEl?.focus({ preventScroll: true }));
  }

  /** ⌘M / «В окно…»: the selection, else the card the arrows are on, else the active tab. */
  function openMoveKeys(): void {
    const selectedNow = selectedIds();
    const kb = kbTarget(ds, visible);
    const ids = selectedNow.length > 0 ? selectedNow : kb ? [kb] : list.activeId ? [list.activeId] : [];
    if (ids.length > 0) openCarousel('keys', ids);
  }

  function onCarouselKey(e: KeyboardEvent): void {
    const key = carouselKey(e);
    if (key === 'none') {
      // Nothing may reach the search or the editor behind the carousel.
      if (!e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const c = car;
    if (!c) return;
    if (key === 'cancel') {
      closeCarousel();
      void tick().then(() => listEl?.focus({ preventScroll: true }));
      return;
    }
    if (!c.items || c.got !== null) return;
    if (key === 'choose') {
      pick(c.kb);
      return;
    }
    const kb = moveKbIndex(c.kb, key === 'up' ? -1 : 1, c.items.length);
    car = { ...c, kb };
    carHandle?.reveal(kb);
  }

  /** Over the page right of the drawer: the carousel; back over the drawer: gone (mockup `carouselFollow`). */
  function followCarousel(x: number, y: number, inList: boolean): void {
    const d = drag;
    if (!d) return;
    const right = asideEl?.getBoundingClientRect().right ?? 0;
    const want = !inList && wantsCarousel(x, y, right, window.innerWidth, window.innerHeight);
    if (want && !car) openCarousel('drag', d.ids);
    else if (!want && car?.mode === 'drag' && car.got === null) closeCarousel();
    refreshHot();
  }
```

`beginDrag`: before `return true;` add `windowsFetch = fetchWindows();`.

`dragMove`: after `if (inList) autoScroll(ev.clientY);` add `followCarousel(ev.clientX, ev.clientY, inList);`.

`finishDrag` becomes:

```ts
  function finishDrag(dropped: boolean): void {
    const d = drag;
    drag = null;
    windowsFetch = null;
    const c = car;
    if (dropped && c?.mode === 'drag' && c.hot !== null) {
      pick(c.hot);
    } else {
      if (c?.mode === 'drag') closeCarousel();
      if (dropped && d?.inList) onreorder(moveIds(list.tabs.map((tab) => tab.id), d.ids, d.before));
    }
    if (ds.mode === 'hover' && !inWrap) scheduleHoverClose();
  }
```

- [ ] **Step 4: Implement — markup and styles**

Root: add `class:car={car !== null}` to `<div class="tab-drawer" …>`.

Selection bar: before the «В новое окно» button:

```svelte
        <button type="button" onclick={openMoveKeys}>{t('tabs.selection.to_window')}</button>
```

The ghost block becomes:

```svelte
  {#if drag}
    {@const inCar = car?.mode === 'drag'}
    {@const hotItem = car && car.hot !== null ? car.items?.[car.hot] : undefined}
    <div
      class="ghost"
      class:multi={drag.ids.length > 1}
      class:cancel={!drag.inList && !hotItem}
      class:as-car={inCar}
      aria-hidden="true"
      style:width={inCar ? null : `${drag.width}px`}
      style:transform={inCar
        ? `translate(${drag.x - 40}px, ${drag.y - 12}px)`
        : `translate(${drag.x - drag.ox}px, ${drag.y - drag.oy}px) rotate(-1.2deg)`}
    >
      <div class="ghost-bar">
        <i></i><i></i><i></i><span
          >{hotItem ? (hotItem.kind === 'new' ? t('tabs.carousel.new_window_short') : `→ #${hotItem.number ?? '?'}`) : ''}</span
        >
      </div>
      <div class="ghost-body">
        <div class="ghost-name">{tabName(drag.lead.path)}</div>
        <div class="ghost-meta">{metaText(drag.lead)}</div>
      </div>
      {#if drag.ids.length > 1}<div class="ghost-count">{drag.ids.length}</div>{/if}
    </div>
  {/if}

  {#if car}
    <WindowCarousel
      bind:handle={carHandle}
      items={car.items}
      mode={car.mode}
      kb={car.kb}
      hot={car.hot}
      got={car.got}
      left={car.left}
      count={car.ids.length}
      lead={car.lead}
      pointer={car.mode === 'drag' && drag ? { x: drag.x, y: drag.y } : null}
      onpick={pick}
      onscroll={refreshHot}
    />
  {/if}
```

Styles — the mockup's ghost bar and `as-car` (l.402–404, 552–553), and the darker scrim (l.509):

```css
  .car .scrim {
    opacity: 0.82;
  }

  .ghost {
    transition:
      opacity 0.18s,
      width 0.22s var(--tabs-ease);
  }

  .ghost-bar {
    height: 0;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 10px;
    background: var(--bg-surface);
    overflow: hidden;
    transition: height 0.22s var(--tabs-ease);
    font-size: 11px;
    color: var(--text-subtle);
  }

  .ghost-bar i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--highlight);
    display: block;
  }

  .ghost-bar span {
    margin-left: auto;
    font-weight: 600;
  }

  .ghost.as-car {
    width: 220px;
    outline: 2px solid var(--tabs-brand-a);
  }

  .ghost.as-car .ghost-bar {
    height: 24px;
  }
```

(merge the `.ghost` `transition` into the existing `.ghost` rule rather than adding a second one), and inside the existing `@media (prefers-reduced-motion: reduce)` block add:

```css
    .ghost,
    .ghost-bar {
      transition: none;
    }
```

- [ ] **Step 5: `App.svelte`**

After `drawerSource`:

```ts
  /** The other windows, for the drawer's carousel (plan 05, `tab_carousel_windows`). */
  const carouselSource = {
    windows: () => invoke<CarouselWindow[]>('tab_carousel_windows').catch((): CarouselWindow[] => []),
  };

  /** The window carousel is up: the page behind it blurs (D9, D11). */
  let carouselOn = $state(false);

  /** A move from the drawer's carousel (plan 05). A refusal already has its toast (`mayLeave`). */
  async function moveTabs(tabIds: string[], target: MoveTarget): Promise<void> {
    const paths = tabIds.map((id) => tabList.tabs.find((tab) => tab.id === id)?.path ?? null);
    const outcome = await tabs.moveTabs(tabIds, target);
    if (outcome?.kind === 'failed') reportStranded(paths.map((path) => ({ path, error: outcome.error })));
  }
```

(`import type { CarouselWindow, MoveTarget } from './lib/tabs/carousel';`.) `<main data-zoom={zoom.level}>` becomes `<main data-zoom={zoom.level} class:carousel-on={carouselOn}>`. On `<TabDrawer>`, after `onnewwindows`:

```svelte
  {carouselSource}
  onmove={(tabIds, target) => void moveTabs(tabIds, target)}
  oncarousel={(on) => {
    carouselOn = on;
  }}
```

The `main` style becomes:

```css
  main {
    height: 100vh;
    width: 100vw;
    transition: filter 0.28s var(--tabs-ease);
  }

  /* Plan 05: the page behind the window carousel (mockup `.carousel-on .editor`). */
  main.carousel-on {
    filter: blur(9px) saturate(0.85);
  }

  /* D11: no blur and no transition — the scrim alone dims the page. */
  @media (prefers-reduced-motion: reduce) {
    main {
      transition: none;
    }
    main.carousel-on {
      filter: none;
    }
  }
```

- [ ] **Step 6: Run**

Run: `npx vitest run src/lib/tabs/TabDrawer.svelte.test.ts` → PASS (old and new). `npx vitest run --dir src` → **86 files / 1810 tests**. `npm run check` → 0 errors, no new warnings.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tabs/TabDrawer.svelte src/lib/tabs/TabDrawer.svelte.test.ts src/App.svelte locales/ru/app.json locales/en/app.json locales/de/app.json locales/fr/app.json locales/es/app.json locales/zh/app.json
git commit -m "$(cat <<'EOF'
feat(tabs): drag a card out of the drawer to the window carousel; ⌘M and «В окно…»

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/tabs/TabDrawer.svelte src/lib/tabs/TabDrawer.svelte.test.ts src/App.svelte locales/ru/app.json locales/en/app.json locales/de/app.json locales/fr/app.json locales/es/app.json locales/zh/app.json
```

---

## Task 11: «Перенесено в #N · Перейти»

**Files:**
- Modify: `src/lib/toasts.svelte.ts` (`ToastPayload`, `ORDER`)
- Modify: `src/lib/ToastStack.svelte` (props; after the `tabs-stranded` arm)
- Modify: `src/App.svelte` (`moveTabs`, `moveTabsToNewWindows`, `<ToastStack>`)
- Modify: `locales/{ru,en,de,fr,es,zh}/app.json`
- Test: `src/lib/ToastStack.svelte.test.ts`

- [ ] **Step 1: Locale keys**

| key | ru | en | de | fr | es | zh |
|---|---|---|---|---|---|---|
| `toast.tabs_moved.headline` | Перенесено в {windows} | Moved to {windows} | Verschoben nach {windows} | Déplacé vers {windows} | Movido a {windows} | 已移到 {windows} |
| `toast.tabs_moved.go` | Перейти | Go there | Hinwechseln | Y aller | Ir allí | 前往 |

- [ ] **Step 2: Failing tests**

Append to `src/lib/ToastStack.svelte.test.ts` (add `vi` to the vitest import):

```ts
describe('ToastStack: tabs moved to another window (plan 05)', () => {
  function renderMoved(numbers: (number | null)[]) {
    const store = createToastStore();
    store.push({ kind: 'tabs-moved', label: 'editor-4', numbers });
    const onRevealWindow = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(ToastStack, { target, props: { store, onRevealWindow } });
    flushSync();
    cleanup = () => {
      unmount(component);
      target.remove();
    };
    return { root: target, store, onRevealWindow };
  }

  it('SaysWhereTheTabsWent_AndGoesThereOnClick', () => {
    const { root, store, onRevealWindow } = renderMoved([18]);
    expect(root.querySelector('.md-toast-text')?.textContent?.trim()).toBe('Moved to #18');
    root.querySelector<HTMLButtonElement>('.md-toast-action')!.click();
    expect(onRevealWindow).toHaveBeenCalledWith('editor-4');
    expect(store.hasKind('tabs-moved')).toBe(false);
  });

  it('NamesEveryNewWindow_InRussianToo', () => {
    installCatalog('ru');
    const { root } = renderMoved([19, 20]);
    expect(root.querySelector('.md-toast-text')?.textContent?.trim()).toBe('Перенесено в #19, #20');
  });
});
```

Run: `npx vitest run src/lib/ToastStack.svelte.test.ts` → FAIL (type error on the new kind).

- [ ] **Step 3: Implement**

`toasts.svelte.ts`, after the `tabs-stranded` payload:

```ts
  /**
   * Tabs went to another window (plan 05) and the human stayed here: where
   * they went, and «Перейти». The only toast that goes by itself (App
   * dismisses it after a few seconds): it reports a success, and a standing
   * one per move would pile up. `label` is the first window, `numbers` every
   * window's `#N`.
   */
  | { kind: 'tabs-moved'; label: string; numbers: (number | null)[] }
```

and `'tabs-moved': 4,` in `ORDER` next to `'tabs-stranded'`.

`ToastStack.svelte` props: add `onRevealWindow` with its type:

```ts
    /** «Перейти» on a `tabs-moved` toast: bring that window forward (`reveal_other_window`). */
    onRevealWindow?: (label: string) => void;
```

After the `tabs-stranded` arm:

```svelte
        {:else if toast.payload.kind === 'tabs-moved'}
          {@const moved = toast.payload}
          <span class="md-toast-text">
            {t('toast.tabs_moved.headline', { windows: moved.numbers.map((n) => `#${n ?? '?'}`).join(', ') })}
          </span>
          <button
            class="md-toast-cmd md-toast-action"
            onclick={() => {
              onRevealWindow?.(moved.label);
              dismiss(toast);
            }}
          >
            {t('toast.tabs_moved.go')}
          </button>
```

`App.svelte`, next to `reportStranded`:

```ts
  /** How long «Перенесено в #N» stays (D5). */
  const TABS_MOVED_TOAST_MS = 6000;

  function announceMoved(moved: readonly MoveDone[]): void {
    if (moved.length === 0) return;
    const id = toasts.push({ kind: 'tabs-moved', label: moved[0].label, numbers: moved.map((m) => m.number) });
    setTimeout(() => toasts.dismiss(id), TABS_MOVED_TOAST_MS);
  }
```

In `moveTabs`: `if (outcome?.kind === 'moved') announceMoved([{ label: outcome.label, number: outcome.number }]);` before the failure branch. In `moveTabsToNewWindows`: `if (outcome) { announceMoved(outcome.moved); reportStranded(outcome.stranded); }`. On `<ToastStack>`:

```svelte
  onRevealWindow={(label) => {
    invoke('reveal_other_window', { label }).catch(logTabIpc('reveal_other_window'));
  }}
```

- [ ] **Step 4: Run**

Run: `npx vitest run --dir src` → **86 files / 1812 tests**. `npm run check` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/toasts.svelte.ts src/lib/ToastStack.svelte src/lib/ToastStack.svelte.test.ts src/App.svelte locales/ru/app.json locales/en/app.json locales/de/app.json locales/fr/app.json locales/es/app.json locales/zh/app.json
git commit -m "$(cat <<'EOF'
feat(tabs): «Перенесено в #N · Перейти» after a move

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- src/lib/toasts.svelte.ts src/lib/ToastStack.svelte src/lib/ToastStack.svelte.test.ts src/App.svelte locales/ru/app.json locales/en/app.json locales/de/app.json locales/fr/app.json locales/es/app.json locales/zh/app.json
```

---

## Task 12: Docs

**Files:**
- Modify: `CLAUDE.md` (Architecture l.44–45, l.106–108; gotchas l.309, l.311, l.317; one new gotcha)
- Modify: `docs/ai-interface.md` (`## Windows, tabs and routing` table, l.462–475)
- Modify: `docs/superpowers/plans/tabs-questions.md` (Q2; new Q11)

- [ ] **Step 1: `CLAUDE.md` — Architecture**

- `tabs.rs` line → `# Tab registry behind OpenFiles: window → #N, ordered tabs, active; one file = one tab app-wide; move_tabs (all or nothing, tombstones the source)`
- `tab_commands.rs` line → `# Tab IPC (tab_owner/open/claim/release/activate/close), decided under the registry lock; tab_move (plan 05: registry + AiPending + hand-over in one step) and tab_carousel_windows`
- after the `TabNotch.svelte / TabDrawer.svelte / TabCard.svelte` line add:
  ```
      WindowCarousel.svelte # Plan 05: the other windows as thumbnails while a card is dragged onto the page or ⌘M asked; listbox; edge zones + wheel
      carousel.ts         # Pure carousel model: order («+ Новое окно» first, MRU), keys, edge glide, reveal, when it is up
  ```

- [ ] **Step 2: `CLAUDE.md` — gotchas**

- **Lock orders** (l.309): after `` `OpenFiles` → `AiQueue` `` insert `` ; `OpenFiles` → `AiPending` (`tab_move` re-labels the moved files' requests under the registry lock; nothing takes `AiPending` and then the registry — `ai_respond` drops the registry guard first) ``.
- **The window init contract** (l.311): the listener list becomes `(`open-file`, `reopen-tab`, `ai-command`, `tabs-arrive`)`, and after "goes through `tab_open`." add: "The exception is `tabs-arrive` (plan 05): its tabs were moved in the registry by `tab_move` and are shown with `tabs.arrive`, never `tab_open`."
- **Stamps** (l.317): replace the last sentence ("Plan 05, which moves tabs between windows anyway, carries them.") with: "A move between windows (plan 05, `tab_move`) carries them — and the caret, a quick look's state and the agent inbox — in `MovedTab` → `PendingTab`; «В новые окна» is such a move now."
- New gotcha, after the stamps one:

```markdown
- **Moving tabs between windows is one Rust step, `tab_move`, never a release plus an open.** Under the one `OpenFiles` lock it moves the registry entries (`TabRegistry::move_tabs`: all or nothing, the source tombstoned so a late heartbeat cannot bring the tab back, the target's tombstone cleared), re-labels `AiPending` for the moved files (agents keep waiting — on the target — and `ai_respond` from the target is accepted), and hands the tabs to the target: `tabs-arrive` when it has mounted, its pending payload when it was built for the move (the same decision `queue_tab` makes under the same locks); the session snapshot, with the untitled sidecar name, follows right after. The source frontend (`controller.moveNow`) swaps to the neighbour *before* the IPC, so the one `await` never sits between the last dirty check and the swap. A command already on its way to the source when the move ran is handed on with `ai_forward` instead of being answered from the wrong window. Undo history does not move.
- **⌘M is a drawer key («В окно…»), like ⌘L/⌘R/⌘U** — `DRAWER_MOVE_KEY` in `drawer-keys.ts`, and `drawer-keys.test.ts` fails if `menu.rs` ever claims it or gains a predefined Minimize (which carries ⌘M without an accelerator string).
- **Svelte 5 attaches `onwheel` (and touch) handlers as passive**, so `preventDefault` there is ignored and the page behind scrolls. A wheel that must be taken needs `addEventListener('wheel', …, { passive: false })` in an `$effect` (`WindowCarousel.svelte`).
```

- [ ] **Step 3: `docs/ai-interface.md`**

In the `## Windows, tabs and routing` table, after the `The user leaves a tab showing a pending ask` row, add:

```markdown
| The user moves the tab to another window (the drawer's window carousel, ⌘M) | Nothing changes for the agent. A pending request goes with the tab and is answered from its new window; a question waiting for the tab waits there; the next response carries the new `window`, and routing finds the file there. A command already on its way to the old window is handed on to the new one. |
```

- [ ] **Step 4: `tabs-questions.md`**

Under `## Q2`, add a line: `- **Сделано в плане 05** (`2026-09-25-tabs-05-carousel.md`): карусель, ⌘M / «В окно…», атомарный перенос `tab_move`. Перетаскивание за край окна — в известных пробелах плана.` Append:

```markdown
## Q11. Три решения плана 05, которые стоит подтвердить глазами
- **Контекст:** план 05, D4, D5, D10.
- **Что сделано:** (1) в окне-цели перенесённая вкладка сразу становится активной (как в макете), если текущую там можно покинуть; (2) тост «Перенесено в #N · Перейти» исчезает сам через 6 с — единственный такой тост; (3) клавиша «В окно…» — ⌘M, работает только при открытом ящике.
- **Альтернативы:** (1) приезжать в фон, «Перейти» активирует; (2) тост висит до крестика, как остальные; (3) другая клавиша или только кнопка в панели выделения.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/ai-interface.md docs/superpowers/plans/tabs-questions.md
git commit -m "$(cat <<'EOF'
docs(tabs): plan 05 — tab_move, the carousel, ⌘M; stamps now travel

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- CLAUDE.md docs/ai-interface.md docs/superpowers/plans/tabs-questions.md
```

---

## Task 13: QA — the mockup in four themes, the dev app live, final gates

**Files:**
- Create (outside the repo): `$CLAUDE_JOB_DIR/tmp/tabs05/{vite.qa.config.mts,carousel-qa.mjs,axmenu,ai.py}` (outside a background job use `/tmp/tabs05-qa` wherever `$CLAUDE_JOB_DIR/tmp/tabs05` appears)
- Create: `docs/superpowers/plans/night-shots/tabs05-app-carousel-*.png`, `docs/superpowers/plans/night-shots/tabs05-dev-*.png`
- Modify: `docs/superpowers/plans/2026-09-25-tabs-night-report.md` (a plan 05 section: what was built, the shots, Known gaps)

**Safety — read first, follow verbatim.**
- The dev app only via `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target npm run dev:app`.
- Never `npm run tauri dev`, `npm run tauri build`, `npm run build:universal`, and nothing in `/Applications`.
- The CLI only with `--socket /tmp/md_mini_dev_cmd.sock`.
- Never System Events, `osascript` or OS keystrokes; menus only via the guarded AX helper (`tmp/tabs03/axmenu`, which checks that the pid's executable is `~/.cargo/tabs-impl-target/debug/md-mini`).
- Ports 1420/1430/1440 may belong to others.
- Kill only your own recorded PIDs.

- [ ] **Step 1: Automated gates**

All must pass before any live run:
- `npx vitest run --dir src` → 86 files, 1812 tests, 0 failed.
- `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^test result"` → `580 passed; 0 failed; 3 ignored`.
- the clippy line → `50 warnings`.
- `npm run check` → 0 errors.
- `CARGO_TARGET_DIR=~/.cargo/tabs-impl-target npm run check:x86` → builds.

- [ ] **Step 2: Playwright — the app against the mockup, four themes**

Private Vite exactly as plan 03 Task 16 Step 1 (`2026-09-25-tabs-03-drawer.md`, the `vite.qa.config.mts` block), with `$QA="$CLAUDE_JOB_DIR/tmp/tabs05"` and a free port ≥ 1455 (`lsof -ti:<port>` must print nothing); start it with `run_in_background`, record its PID to `$QA/vite-qa.pid`.

`$QA/carousel-qa.mjs`: start from plan 03 Task 16 Step 2's `drawer-qa.mjs` (the `grab`, `stub`, `appPage`, `mockPage`, `shots` helpers — copy them; point `MOCKUP` at `docs/investigations/2026-09-24-tabs-mockup/drawer-carousel.html` and `TMP` at `$QA`). Extend `stub`'s `switch` with:

```js
          case 'tab_carousel_windows': return ${JSON.stringify(WINDOWS)};
          case 'tab_move': window.__moved.push(args); return { label: args.target.kind === 'window' ? args.target.label : 'editor-99', number: 99 };
```

(and `window.__moved = [];` next to `window.__calls = [];`), where, above `stub`:

```js
// The mockup's "off-screen" windows, most recently focused first — what Rust would send.
const OFFSCREEN = grab('OFFSCREEN');
const WINDOWS = [...OFFSCREEN]
  .sort((a, b) => b.focusedAt - a.focusedAt)
  .map((o) => ({
    label: `editor-${o.id}`,
    number: o.id,
    project: o.tabs[0].proj,
    branch: o.tabs[0].br,
    tabCount: o.tabs.length,
    activePath: o.tabs[0].proj ? `/qa05/${o.tabs[0].proj}/${o.tabs[0].name}` : null,
    head: o.tabs[0].md,
  }));

/** Press on the second card, carry it to the middle of the page in steps, and hold. */
async function dragToPage(page, cardSel, target = { x: 650, y: 320 }) {
  const box = await page.locator(cardSel).nth(1).boundingBox();
  await page.mouse.move(box.x + 40, box.y + 20);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + 40 + ((target.x - box.x - 40) * i) / 12, box.y + 20 + ((target.y - box.y - 20) * i) / 12);
    await wait(page, 16);
  }
  await wait(page, 500);
}
const thumbs = (page, sel) =>
  page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent.match(/#\d+/)?.[0] ?? 'new'), sel);
```

Per theme `light`, `dark`, `aurora-light`, `aurora-dark` (app and mockup side by side through `shots`, into `docs/superpowers/plans/night-shots/tabs05-app-carousel-<theme>-0N.png`):
1. **open** — open the drawer (`openApp` / `openMock`), `dragToPage` in both (`.tab-list [role="tab"]` / `#tabCards .card`). Checks: `thumbs(app, '[data-carousel-item]')` equals `thumbs(mock, '.wthumb')` (`new`, then `#12 #7 #15 #18 #19`); the app's `.carousel .car-head` names the dragged card; `.ghost.as-car` exists; `getComputedStyle(document.querySelector('main')).filter` contains `blur`.
2. **scrolled** — `page.mouse.move(650, <viewport height − 40>)` in both, `wait 1200` → the app's `.car-edge.top.on` exists.
3. **hot** — move onto the thumbnail `#18` (its `boundingBox()` centre) in both → the app's `[data-carousel-item].hot` reads `#18`, `.ghost-bar span` reads `→ #18`.
4. **dropped** — `page.mouse.up()` in both, `wait 500` → `window.__moved` in the app is `[{ tabs: [ { tabId: <the dragged card's id>, … } ], target: { kind: 'window', label: 'editor-18' } }]`; its card is gone from `.tab-list` only after the controller published (the stub answers `tab_move` at once).

Once, in `aurora-light`: a page with `reducedMotion: 'reduce'` (`appPage('aurora-light', 'reduce')`): `dragToPage` → `main`'s computed `filter` is `none`, `.carousel` has `animation-name: none`. And the keyboard path: open the drawer, `page.keyboard.press('Meta+m')` → `document.activeElement.getAttribute('role') === 'listbox'`, `aria-activedescendant` names the option reading `#12`; `ArrowDown` → `#7`; `Enter` → `window.__moved.at(-1).target.label === 'editor-7'`.

Run `node "$QA/carousel-qa.mjs"`; it prints `results` and `errors`. Every check `true`, `errors` empty (a `console.error` from a stubbed IPC the app logs by design — `get_window_init`-style retries — is listed with its text in the report, not hidden). Differences you see in the side-by-side shots are listed for the owner, not "fixed" by eye.

- [ ] **Step 3: The dev app, live**

Scratch files and the dev app as plan 04 Task 15 Steps 2–3 (`2026-09-25-tabs-04-ai-cli.md`), with `/tmp/tabs05` for the scratch projects (`p1` with a `.git/HEAD`, `p2` plain; files `a b c d` in `p1`, `e f` in `p2`, each `# <name>\n\nline two\nline three\n`), `$QA` above, and the window title `tabs-05 · local`. Record the app PID (`ps -o pid,lstart,command` — started after your launch) to `$QA/app.pid`; `test -S /tmp/md_mini_dev_cmd.sock`. `BIN=~/.cargo/tabs-impl-target/debug/md-mini`, `SOCK=/tmp/md_mini_dev_cmd.sock`. `ai.py` is plan 04's (its socket is hard-coded to the dev one). Build the AX helper into `$QA/axmenu` from plan 03 Task 16 Step 3 if `tmp/tabs03/axmenu` is not there.

Set-up: `$BIN ai open /tmp/tabs05/p1/a.md /tmp/tabs05/p1/b.md /tmp/tabs05/p1/c.md -t <main's #> --socket $SOCK` and `CLAUDECODE=1 $BIN ai open /tmp/tabs05/p2/e.md --socket $SOCK` (a second window, B). Drive the drawer by eval in the window under test (`mcp__tauri__webview_execute_js`, fire-then-read for anything async): pointer events carry `buttons: 1` on moves, the thumbnail is found with `document.querySelector('[data-carousel-item="1"]').getBoundingClientRect()`; keys go to `document.body` with `code` set.

1. **A file tab by drag.** In A, open the drawer (`axmenu … press "View" "Tabs" "<Show Tabs>"`), drag `b.md`'s card onto the page, onto B's thumbnail, release. **Expected:** A shows its neighbour `c.md`; the toast «Перенесено в #B · Перейти» (or its English) → `tabs05-dev-01-moved.png`; `$BIN ai ls --json --socket $SOCK` lists `b.md` under B; window numbers unchanged. Click «Перейти» (eval `.md-toast-action` click) → in B `document.hasFocus()` → `true`, `b.md` active there.
2. **An untitled tab with text.** In A: `axmenu … press "File" "<New Tab>"`, eval-insert `draft text` into the editor (`document.querySelector('.cm-content').cmTile.root.view.dispatch({ changes: { from: 0, insert: 'draft text' } })`), wait 6 s (a heartbeat), move it to B with ⌘M (step 6's keys). **Expected:** B shows `draft text`; `session-v2.json` in `~/Library/Application Support/md-mini-dev/` lists that tab id under B's window with its `untitled` name unchanged, and the sidecar file exists.
3. **A group, to a new window.** In A ⇧-click `a.md` and `c.md` (pointerdown with `shiftKey`), drag one of them onto «+ Новое окно». **Expected:** one ghost with `2`; a new window C, built behind A (in A `document.hasFocus()` stays `true`), holds `a.md, c.md` in that order → `tabs05-dev-02-group.png`.
4. **The last tab closes its window.** In C, drag its active tab to B, then the other one. **Expected:** after the second, C closes; `$BIN ai ls --socket $SOCK` no longer lists C's number, and B holds both.
5. **An agent's question follows the tab.** With `run_in_background`: `python3 "$QA/ai.py" '{"v":1,"cmd":"ask","path":"/tmp/tabs05/p1/d.md","question":"Ship it?","options":["Yes","No"],"timeout_secs":120}' 130 > "$QA/ask.out"` (routed to A, a background tab there, shimmering). Move `d.md` from A to B by drag. In B activate `d.md` → `.cm-ai-ask` with "Ship it?" → click `Yes` by eval. **Expected:** `$QA/ask.out` is `{"ok":true,"answer":"Yes","window":<B's #>}` — never `tab released` — → `tabs05-dev-03-ask-followed.png`.
6. **Keyboard.** In B focus a card with the arrow keys (open the drawer, dispatch `ArrowDown` on `document.body`), then `document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'m', code:'KeyM', metaKey:true, bubbles:true, cancelable:true}))`. **Expected:** the listbox has focus with an `aria-activedescendant`; `ArrowUp`/`ArrowDown` move it; `Escape` closes it and the drawer keeps the keys; ⌘M again, `Enter` on A's thumbnail moves the card → `tabs05-dev-04-keys.png`.
7. **A single window.** Close every window but one (their close buttons by eval of `getCurrentWindow().close()` inside each, or ⌘W on their last tabs through the AX helper). ⌘M in the drawer → only «+ Новое окно» → `tabs05-dev-05-alone.png`; Esc.
8. **Esc cancels a drag.** Start a drag onto the page, dispatch `Escape` → no ghost, no carousel, nothing moved.
9. **For the owner's eye:** with a drag held over the page (no pointerup), take `mcp__tauri__webview_screenshot` in each of the four themes (Theme menu through the AX helper, `data-theme` checked by eval) → `tabs05-dev-carousel-{light,dark,aurora-light,aurora-dark}.png`. Put the theme back.
10. **Quit.** `axmenu … press "<app menu title>" "<Quit title>"`; then `kill "$(cat "$QA/vite-qa.pid")"` — only that PID.

- [ ] **Step 4: Report and commit**

Add a `## План 05 — карусель окон` section to the night report (what was built, the must-haves → where they are proved, the shots, Known gaps below, anything a scenario showed that the plan did not expect). Then:

```bash
git add docs/superpowers/plans/night-shots/tabs05-app-carousel-*.png docs/superpowers/plans/night-shots/tabs05-dev-*.png docs/superpowers/plans/2026-09-25-tabs-night-report.md
git commit -m "$(cat <<'EOF'
docs(tabs): plan 05 QA — the carousel against the mockup in four themes, dev app scenarios

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)" -- docs/superpowers/plans/night-shots/tabs05-app-carousel-*.png docs/superpowers/plans/night-shots/tabs05-dev-*.png docs/superpowers/plans/2026-09-25-tabs-night-report.md
```

---

## Known gaps

1. **Dragging past the window edge** (spec §6: a card dropped onto another OS window, or into the void → a window at the drop point; §13 q.2) is not built. The pointer never leaves the window; «+ Новое окно» cascades (`build_window`). If it is built later, it is an extra target for the same `tab_move`.
2. **Undo history does not move** — an `EditorState` cannot cross webviews. A moved file tab re-reads its file in the target (the caret and top line are kept, not the pixel scroll); an untitled tab moves its text.
3. **Thumbnails are data, not screenshots:** the first ≤ 2 KB of the active document as preview lines (tables, mermaid and code render as text). An untitled document's thumbnail can be up to one heartbeat (5 s) old.
4. **The window list is read when the drag starts (or ⌘M):** a window opened meanwhile is not offered; one closed meanwhile makes the move fail — the tabs stay, with the `tabs-stranded` toast.
5. **A target that closes between `tab_move` and handling `tabs-arrive`** takes the tabs with it, as closing any window does (file tabs to ⌘⇧T via `record_window_close`; an untitled text is lost).
6. **A moved tab whose file is unreadable in the target** is released there, and its agents get `tab released` — the only way a move can surface to an agent.
7. **Arrivals into a target whose active tab may not be left** wait in its background without a toast (D4): the human is in the other window, and the tabs are there in the drawer.






