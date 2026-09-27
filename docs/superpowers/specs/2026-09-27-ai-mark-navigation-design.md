# AI mark navigation — ⌘' / ⌘⇧'

## Goal

Jump between the places an AI left in the document, in a cycle: ⌘' goes to the
next one after the caret, ⌘⇧' to the previous one. Both wrap around.

## What counts as an AI mark

One sorted list, built on demand from the editor state. Nothing is cached.

| Source | Field | Position of the mark |
|---|---|---|
| Highlighted edit (`couplet edit`) | `aiHighlightField` (`ai-highlight.ts`) | start of each highlighted span; adjacent or overlapping spans are merged into one mark |
| Comment thread | `aiCommentField` (`ai-comment.ts`) | start of the anchor highlight; for an orphaned thread (no anchor), the widget position |
| Question (`ask`) | `aiAskField` (`ai-ask.ts`) | the widget position |

Line-wash and pulse decorations are not marks: they only duplicate a span or
are transient. Several marks at the same position count as one.

## Behaviour

- **Next:** the first mark whose position is strictly after the caret head.
  If there is none, wrap to the first mark in the document.
- **Previous:** the last mark whose position is strictly before the caret head.
  If there is none, wrap to the last one.
- **Moving:** the caret collapses onto the mark position, and the view scrolls
  it into view (`EditorView.scrollIntoView(pos, { y: 'center' })`). The editor
  gets focus.
- **No marks:** nothing happens. No toast, no beep.
- A folded region that contains the target is unfolded, so the caret never
  lands inside hidden text.

## Wiring

- Two items in the native **AI** menu (`menu.rs`), right after "Comment on
  Selection": `ai_next_mark` (`CmdOrCtrl+Quote`) and `ai_prev_mark`
  (`CmdOrCtrl+Shift+Quote`). Menu accelerators rather than a CM6 keymap,
  because the key has to work while focus is inside a comment box too, and a
  feature needs a menu entry a user can find (the PR #11 lesson).
- Ids fall through the generic `menu-event` emit. The frontend switches on
  them in `App.svelte` next to `ai_comment`.
- Mirrored in `native-menu-accelerators.ts`; its test enforces equality with
  `menu.rs`.
- Labels are in the i18n catalogs, both Rust and TS if both exist, in every
  language already supported.

## Code layout

- `src/lib/editor/ai-mark-nav.ts` is pure: it builds `aiMarkPositions(state)`
  and `nextAiMark(state, dir)` → position | null, plus the
  `gotoAiMark(view, dir)` command.
- `src/lib/editor/ai-mark-nav.test.ts` builds states with `EditorState.create`
  and covers every source, merging, dedup, wrap in both directions, a caret
  sitting exactly on a mark, and no marks.

## Out of scope

- A counter ("2 of 5").
- Filtering by mark type.
- Moving between tabs or windows.
