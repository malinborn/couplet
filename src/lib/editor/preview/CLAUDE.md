# Preview Decorations — Developer Guide

This directory implements CM6 live-preview decorations for markdown elements.

## Architecture

Each file handles one category of markdown elements. All are called from `plugin.ts` which walks the Lezer syntax tree and dispatches to the appropriate decorator.

| File | Elements | Decoration Types |
|------|----------|-----------------|
| `headings.ts` | `# H1` through `###### H6` | Line + replace (hides `#` marks) |
| `inline.ts` | Bold, italic, strikethrough, code, links | Mark + replace |
| `lists.ts` | Bullets, checkboxes, blockquotes | Replace (widget) + line |
| `blocks.ts` | Code blocks, horizontal rules | Line decorations |
| `tables.ts` | GFM tables | Line + replace (single TableWidget on header line, other lines hidden) |
| `utils.ts` | `cursorInRange()` helper | — |

## Critical Rules

### Decoration Ordering (RangeSetBuilder)

CM6 `RangeSetBuilder` **crashes** if decorations are not in `(from, startSide)` order:

1. `Decoration.line()` — added at `line.from`, has implicit low startSide
2. `Decoration.mark()` — has lower startSide than replace at same position
3. `Decoration.replace()` — has higher startSide

At the same `from` position: **line → mark → replace**.

### No Cross-Line Replace

`Decoration.replace()` spanning across `\n` causes rendering glitches. Use `Decoration.line()` for multi-line visual effects.

### No `block: true` from Plugins

CM6 does not allow `block: true` on decorations from ViewPlugins. Use `Decoration.line({ class: ... })` + CSS pseudo-elements instead.

## Tables (`tables.ts`) — Deep Dive

Tables are the most complex decoration. Key design decisions and hard-won lessons:

### Always Rendered (No `cursorInRange`)

Unlike other elements, tables do **NOT** use `cursorInRange` to toggle between preview and raw mode. Tables are always rendered as widgets. Reasons:
- Clicking a table would cause a jarring visual shift (rendered → raw markdown)
- Cell editing is done via double-click → floating `<textarea>` overlay
- Use `Cmd+E` to switch to raw mode for structural editing

### Delimiter Detection: Position, Not Regex

```typescript
// CORRECT — delimiter is always 2nd line
const isDelimiter = i === startLine.number + 1;

// WRONG — regex matches data rows containing only dashes/colons
const isDelimiter = /^\s*\|[\s|:-]+\|\s*$/.test(line.text);
```

The regex approach breaks when users type dashes in cells — the row gets classified as delimiter and hidden. The position-based approach is correct because GFM delimiter is always the 2nd row.

### Widget `eq()` Must Compare `mode` and `ctx`

The new `TableWidget` (one per table, rendered on the header line via
`Decoration.replace`) holds the wrap/full `mode` plus the entire
`TableContext`. Its `eq()` must compare:
- `mode` (changes from wrap → full and vice versa via the toggle button)
- ctx structural fields (`nodeFrom`, `nodeTo`, `rows.length`, `colCount`)
- `ctx.colWidths` element-wise (so addRow placeholder sizing stays correct)
- Per-row cell `text` and `from` positions

Without these comparisons, CM6 reuses the stale widget after structural
changes (add/delete row/col) or mode toggle, causing wrong DOM positions and
out-of-date rendering.

### Table Operations: Two Strategies

**1. `replaceTable()` — full table replacement via `markdown-table` library**

Used by: `deleteRow`, `addColumn`, `deleteColumn`

- Parses table to 2D grid → modifies grid → serializes with `markdownTable()` → replaces entire table node
- Produces clean, aligned markdown
- Requires correct `ctx.nodeFrom` / `ctx.nodeTo` (see eq() note above)

**2. Direct line insert**

Used by: `addRow`

- Inserts a new line directly after the last row
- Uses `-` as placeholder in cells (visible content so Lezer includes it in Table node)
- **Cannot** use `replaceTable` for add-row because `markdownTable` produces whitespace-only cells for empty rows, and Lezer GFM parser **excludes** rows with only whitespace from the Table node

### Empty Cell Handling

When a cell is empty (e.g., after adding a column), the `from` and `to` positions point to the midpoint of the whitespace between pipes. This is a valid insertion point — editing works by inserting text there.

```typescript
// Empty cell — point to space between pipes for insertion
const midpoint = lineFrom + cellStart + Math.floor(raw.length / 2);
cells.push({ text: '', from: midpoint, to: midpoint });
```

### Cell Editing Overlay

Double-click on a cell shows a `position: fixed` `<textarea>` over the cell:

- The rendered cell text is hidden via the `cm-md-table-cell-editing` class
- The textarea copies the cell's font, line-height and padding, so the glyphs
  land where they were before the double-click (it lives in `document.body`,
  where relative CSS units would resolve against the body font size instead)
- Textarea is positioned using `getBoundingClientRect()` of the cell element
- Auto-grows on every `input` event, and the cell grows with it — see
  "Cell Editing Expands the Cell, Not the Table" below
- Cmd/Ctrl+Enter commits, Tab commits, Escape cancels, blur auto-commits after 50ms
- Plain Enter inserts a newline (textarea default)
- `destroy()` removes the class and the inline sizing it wrote on the cell

Newlines and pipes roundtrip through encoding helpers in
`table-encoding.ts`:
- `decodeForEdit(cellText)`: `<br>` → `\n`, `\|` → `|`
- `encodeForCommit(textareaValue)`: normalize CRLF, `|` → `\|`, trim trailing
  newlines, `\n` → `<br>`

GFM tables can't contain real newlines or unescaped pipes, so the markdown
source always carries `<br>` tags and `\|` escapes for these characters.

### Per-Table Mode (Wrap/Full)

Tables default to `wrap` mode (`max-width: 100%`, cells word-wrap). The
header row's leading ctrl-cell contains a `⇔` toggle button that dispatches
a `toggleTableMode` StateEffect carrying the table's `nodeFrom`. The
`tableModeField` (in `table-state.ts`) is a `RangeSet<TableModeValue>` that
remaps positions through edits (`value.map(tr.changes)`). The mode is read
by `decorateTable` via `getTableMode(view.state, ctx.nodeFrom)` and applied
as a `data-mode` attribute on the widget root.

`livePreviewPlugin` rebuilds decorations on the `toggleTableMode` effect
(parallel to its `mermaidRendered` handling), so the toggle visually
re-renders the widget with the new mode.

State lives in memory only — closing the file resets all tables to `wrap`.

### Selection Snap-Out from Hidden Lines

Delimiter and data lines have `height: 0` so the caret would disappear if
the user navigated onto them. `table-selection.ts` registers an
`EditorView.updateListener` that detects selection on a non-header table
line and dispatches a redirect to either the header line (moved up) or the
line after the table (moved down). The redirect is deferred via
`queueMicrotask` to avoid recursing inside the updateListener.

### `ignoreEvent()` — `false` Everywhere Except Cell Text

The sense of this method is the opposite of what the name suggests to most
readers, and this file used to state it backwards. `eventBelongsToEditor` in
`@codemirror/view` bails out of CM6's own handling when `ignoreEvent(event)`
returns **`true`**. So returning `false`, as `TableWidget` does, means CM6
**does** process the widget's events — which is how a click on a table still
moves the document selection.

The one exemption is a cell's text. It is wrapped in a
`.cm-md-table-celltext` span that is its own nested editing host
(`makeWidgetTextSelectable`, `../widget-text-selection.ts`), because a
`contenteditable="false"` widget island is atomic to Chrome and a drag inside
it selects nothing at all (#31; `user-select: text`,
`-webkit-user-modify: read-only`, `contenteditable="plaintext-only"` and
`user-select: all` were all measured and none of them help).

For that subtree `ignoreEvent` returns `true`, so:

- the browser's own selection stands instead of `MouseSelection` snapping it
  out to the whole table through `atomicRanges`;
- `copy` copies the visible cell text rather than the table's markdown source.

The host refuses every input route (`beforeinput`, `dragstart`) — CM6 does not
own that DOM, so an edit made there would go nowhere and vanish on the next
rebuild — and hides its caret in CSS, since editing still happens through the
double-click overlay. The hover controls stay **outside** the host: a
`contenteditable` ancestor would swallow the mousedown that starts a column
drag.

Consequence worth knowing: while a cell selection is live, DOM focus is on the
cell and `view.hasFocus` is `false`, and `state.selection` never learns the
selection exists at all — CM6 does not process the drag, so it keeps whatever it
held before. Anything asking "is the user working in this editor" must therefore
ask about the hosts too, and anything wanting the selected text must map it back
through `live-render/cell-anchor.ts` (#42). The cell's source range rides on the
host as `data-source-from` / `data-source-to`, put there by
`makeWidgetTextSelectable`; it is safe to freeze into the DOM only because the
widget's `eq()` compares every cell `from`.

### Hover Controls (±)

- **Toggle wrap/full (⇔)**: inline button in the header row's leading ctrl-cell
- **Add row (+)** and **add column (+)**: `position: absolute` against
  `.cm-md-table-wrap`, in the `--table-side-gutter` strip right of the table
- **Delete row (−)**: inline button in each data row's ctrl-cell (left of the drag handle, if >1 data rows)
- **Column drag (⠿) + delete column (−)**: one shared `.cm-md-table-col-ctrl`
  panel per table, in the `--table-col-gutter` strip *above* the header row

All buttons use `opacity: 0` → `opacity: 0.5` on parent hover → `opacity: 1` on button hover.
Buttons use `mousedown` (not `click`) to fire before CM6 processes the event.

#### Why the column panel is one element, positioned from JS (#48)

`.cm-md-table` carries `border-radius` + `overflow: hidden` to clip its corner
cells, and that clip is what used to cut the column buttons in half: they sat
inside a header cell at `top: -8px`, i.e. above the table's own top edge. Three
things are load-bearing in the fix and each one has a dead end behind it:

- **The panel lives in `.cm-md-table-wrap`, not in the cell.** An element only
  escapes an `overflow: hidden` ancestor if its containing block is *outside*
  that ancestor. Moving the radius onto the rows instead would have kept the
  panel in the cell — but **`border-radius` on `display: table-row` does
  nothing in Chrome** (measured at 20px: corners stay square), so the clip has
  to stay on the table.
- **Column alignment is therefore JS.** `createColCtrl`'s `attach` reads the hovered
  header cell's rect once per `mouseenter` and writes `left`. Nothing is read
  per frame or per keystroke.
- **The gutter is `padding-top` on `.cm-line.cm-md-table-header`, not on the
  widget.** Padding on the wrap also reserves the space, but the wrap *is* the
  widget's box and `drawSelection` draws the selection rectangle from that box
  — a grey `--color-selection` bar then appears above the table whenever the
  table is selected (e.g. right after a double-click). On the line the padding
  is ordinary `.cm-line` CSS, the way headings already do it, and CM6 counts it
  in the height map.

The reserved strip is why a table at the very top of the document works: there
is nothing to overflow into up there, so the widget owns the space instead of
borrowing it.

### Cell Editing Expands the Cell, Not the Table (#50)

While a cell is being edited it grows to hold the overlay: `showCellEditor`
writes `min-width` and `height` inline **on the active cell only**. The column
widens and the row grows because `table-layout: auto` reacts to those two
properties — no JS measures or syncs any other row, and no CM6 transaction is
dispatched until the commit.

Three details that are easy to get wrong:

- **`height`, not `min-height`.** Chrome ignores `min-height` on
  `display: table-cell` (CSS 2.1 leaves it undefined); `height` is treated as a
  minimum. With `min-height` the cell stayed 32px under a 67px overlay.
- **The width is computed once** (`cellEditWidth`, unit-tested). Recomputing it
  on input would close the loop *cell width → field width → cell width*, which
  is the per-keystroke table-geometry recalculation this is meant to avoid.
  Only the height follows the text, and the overlay is repositioned from the
  cell's fresh rect afterwards, since widening one column can reflow the others.
- **The rendered text is hidden with `visibility` on the
  `.cm-md-table-cell-editing` class**, not `color: transparent` on the cell:
  `<code>` and `<a>` children set their own colour and used to show through.

### Visual Styles Live on Row and Wrap Elements, Not `.cm-line`

Backgrounds, borders, and border-radius live on `.cm-md-table-row-header`,
`.cm-md-table-row-data`, and `.cm-md-table` — not on `.cm-md-table-line`.
This is because `.cm-md-table-line` has `contain: inline-size` + `display:
flex` to prevent wide tables from expanding `.cm-content` (which breaks
text wrapping). If styles were on the line, they'd extend to viewport width.

- Header gradient: `.cm-md-table .cm-md-table-row-header`
- Even row bg: `.cm-md-table .cm-md-table-row-data:nth-child(even of .cm-md-table-row-data)`
- Last-row border removal: `.cm-md-table .cm-md-table-row:last-child .cm-md-table-cell`
- Table border-radius: `.cm-md-table` (with `overflow: hidden` to clip
  corner cells)
- Right-side buttons (add-col, add-row): `position: absolute` against
  `.cm-md-table-wrap`, so they don't affect column layout

## Mermaid Pan/Zoom (`mermaid-viewport.ts`, `mermaid-state.ts`)

Rendered diagrams sit in a fixed-height frame and can be zoomed and panned.
See `docs/superpowers/specs/2026-07-25-mermaid-pan-zoom-design.md` for the
full design.

### File Split

| File | Responsibility |
|------|----------------|
| `mermaid-viewport.ts` | Pure geometry (`fitScale`, `computeFit`, `clampPan`, `panBy`, `zoomAt`, `wheelIntent`, `autoHeight`) plus `createViewport()`, the DOM controller |
| `mermaid-state.ts` | `StateField<RangeSet<MermaidViewValue>>` holding per-diagram scale/pan/height |
| `mermaid.ts` | Widget; builds a viewport, restores state, commits on settle |

The geometry knows nothing about CodeMirror or the DOM, which is why it is
directly unit-testable (`mermaid-viewport.test.ts`).

### Interaction Rules

- Pinch (`wheel` + `ctrlKey`) and `Cmd`+`wheel` always zoom around the pointer
- Plain `wheel` pans **only when zoomed past fit**; at fit the event is left
  alone so the document scrolls
- Left-drag always pans; double click toggles fit ↔ 2× at the pointer
- The bottom handle resizes the frame; double click on it restores auto height

### Gesture Latching (`GESTURE_GAP_MS`)

Ownership of a wheel gesture is decided **once, at its start**, and held until
the gesture ends — a gap longer than 120 ms with no wheel event. Trackpads emit
a dense stream during a swipe, including inertia, so the gap only elapses once
fingers have actually stopped.

This matters because the naive alternative — deciding per event — hands the
scroll to the document the instant a pan hits an edge, in the middle of a swipe.
That reads as the page lurching out from under you. Instead:

- Mid-gesture at an edge → the diagram keeps the event and rubber-bands
- A **new** gesture at an edge → the document owns it, which is how the user
  scrolls past a diagram
- Cursor outside the diagram → the handler never runs at all

`overscroll-behavior: contain` on a native scroller does the same thing; we
reimplement it because the pan is a transform, not a scroll.

### Rubber Band

`panLeftover()` reports the part of a pan the clamp refused; the raw total is
accumulated and displayed through `rubberBand()`, which damps it asymptotically
toward `OVERSCROLL_LIMIT` (72px). On gesture end a `requestAnimationFrame`
ease-out returns it to zero. Applies to both wheel and drag panning.

Note that `view` itself always stays clamped — the overscroll lives only in
`apply()`, so nothing invalid is ever committed to the state field.

### `userZoomed` Is Tracked, Not Derived

Whether the user has zoomed away from the full view is an explicit flag, **not**
`scale > fitScale`. Shrinking the frame raises the fit scale, which would make
an untouched diagram look zoomed and strand it there permanently — it would
never re-fit, and its wheel events would never pass through to the document
again. The flag is set by `zoom()`, cleared by `fit()`, and derived once on
restore.

### Do NOT Dispatch a Transaction per Frame

Pan/zoom writes `transform` straight to the DOM. `setMermaidView` is dispatched
only on a 150 ms trailing debounce. Dispatching per `wheel` event would run
`livePreviewPlugin.update` → a full decoration rebuild of the document on every
frame.

Corollary: `livePreviewPlugin` must **not** rebuild on `setMermaidView` (unlike
`toggleTableMode`). The visual result is already in the DOM.

### Why State Survives

During pan/zoom `eq()` returns `true`, so CM6 reuses the DOM and the transform
persists on its own. The `StateField` covers the two cases where the DOM is
genuinely rebuilt: the widget scrolled out of the editor viewport and back, or
an edit/theme switch produced a new SVG.

### Widget `eq()` Excludes `pos`

Including `pos` would rebuild the DOM — reparsing the SVG — on every keystroke
above the diagram. Instead commits resolve the live position through
`view.posAtDOM(dom)`, snapped to its line start so it matches the key the
restore path reads.

### Frame Sizing

- `autoHeight` = content height scaled to fit the frame width, capped at 60vh
- A `ResizeObserver` on the frame only reports **width**. Auto height depends on
  `window.innerHeight`, so a `resize` listener is required too, and `remeasure`
  compares the target height as well as the width before bailing out.
- For a width-constrained diagram, fit and auto height agree exactly, so the
  whole diagram is visible with no letterboxing
- A tall diagram is capped at 60vh and fit scales it down — small but complete.
  Zoom in or drag the handle from there.
- `fitScale` never exceeds 1: small diagrams are not upscaled

### The Host Line Needs `contain: inline-size`

The SVG is given its **natural** width so the zoom math and the rendered pixels
agree — which means it will stretch `.cm-content` and break line wrapping across
the whole document unless contained. The fence line therefore carries
`cm-md-mermaid-host-line` with `contain: inline-size` (and `display: flex`, to
drop the `cm-widgetBuffer` height). This is the same fix tables use.

## Reveal Policy (`flavour.ts`)

Whether raw markdown reappears under the caret is **not** a property of the
mode — it is a per-element policy carried by a facet.

```ts
type RevealPolicy = 'on-cursor' | 'never';
LIVE_PREVIEW = { default: 'on-cursor' }
LIVE_RENDER  = { default: 'never', reveal: { mermaid: 'on-cursor' } }
```

Rules for this directory:

- Decorators call `shouldReveal(view, kind, from, to, blockLevel?)`. They must
  **not** call `cursorInRange` directly — that function stays pure and
  separately tested, and `shouldReveal` calls it when the policy says
  `'on-cursor'`.
- Adding an element kind means extending `ElementKind`, not adding a branch.
- `live-preview` behaviour is the facet default, so it is preserved by
  construction. If a change to a decorator alters live-preview, that is a bug
  in the change, not in the test that caught it.
- Tables are pinned to `'never'` under every flavour and have no
  `shouldReveal` call by design — see "Always Rendered" above.
- Mermaid is `'on-cursor'` even in live-render: reverting to the fenced source
  is the only way to edit a diagram, so hiding it permanently would need a
  full nested editor in the inspector. Out of scope for the beta.

## What live-render adds

`src/lib/editor/live-render/` holds everything specific to that flavour, and it
is only in the editor state while the flavour is active. Two things there are
easy to get wrong:

- **Atomicity is two mechanisms.** `EditorView.atomicRanges` covers user caret
  motion, mouse selection and `deleteBy` — nothing else. Programmatic
  `dispatch({selection})` bypasses it, and this app has five such callers
  (search, session restore, history, `table-selection.ts`, slash commands), so
  `atomic.ts` also installs an `EditorState.transactionFilter`. That filter
  consults the same `RangeSet` rather than resolving the node at a point,
  because `decorateLink` hides `](url)` as one span wider than any `LinkMark`.
- **`hiddenMarkRanges` mirrors `plugin.ts`'s traversal**, including its
  `return false` cases. The decoration pass does not descend into inline nodes,
  so the inner `_x_` of `**_x_**` is never hidden — marking it atomic would
  trap the caret in text the user can see.

## Two selections in a table cell, and only one of them gets a toolbar

A cell has two quite different editing surfaces, and #55 was reported from the
second one:

1. **The rendered cell.** Drag across the text without double-clicking. The
   drag lands in the nested editing host (`makeWidgetTextSelectable`), produces
   no document selection at all, and `cell-anchor.ts` maps it back to a source
   range. This is where the format toolbar appears — B / I / S / `</>` / 💬. The
   buttons go through `toggleInlineFormatAt`, a range-taking sibling of
   `toggleInlineFormat`, so a cell and a paragraph agree on what bold means.
   Link is absent on purpose: `toggleLink` opens the inspector, which positions
   with `coordsAtPos` and would therefore draw the URL editor at the table's
   top-left instead of at the cell.
2. **The edit overlay.** Double-click opens a `<textarea>` over the cell,
   holding the cell's *source*. It gets no toolbar, deliberately — the reasoning
   lives on `showCellEditor` in `tables.ts`. Short version: markers are visible
   and typeable there, so the toolbar's whole reason to exist is absent, while
   💬 would anchor a comment to document text the overlay has already diverged
   from.

Worth knowing when reading a bug report: the overlay draws a coloured border
around the cell (`--color-checkbox`), so "the cell had a green outline" means
case 2, not case 1.

## Dependencies

- `markdown-table` — serializes 2D array → GFM markdown table string
- `@lezer/markdown` with `Table` extension — parses GFM tables in the syntax tree
