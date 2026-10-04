# CSV tables: row virtualization (windowed table widget)

> Builds on `2026-10-04-csv-tables-design.md` ("Out of scope: row
> virtualization"). Variant A, chosen by the owner: the existing single table
> widget renders only a window of rows, switched on for CSV through the
> `tableConfig` facet. Markdown tables keep today's path unchanged.

## Goal

Open, scroll and edit a CSV of 100k rows in WKWebView as fluidly as one of
1 000 (the markdown table default), and lift `CSV_TABLE_MAX_ROWS` (20 000, the
stopgap: above it a CSV opens as read-only text) to
the largest size the design actually supports. Every table feature that works
on a CSV today keeps working, including on rows that are not on screen.

## What is broken today, measured

WebKit, 6 columns (perf job `cca9a5d9`, plus the CSV spec's WKWebView table):

| Symptom | Cause | Number |
|---|---|---|
| Open of 10k rows ≈ 2.5 s, 100k hangs the window | the widget builds every row: ~16 DOM nodes per row | 160k nodes at 10k, ~1.6M at 100k |
| Scroll frame 111 ms median at 10k | layout/paint of a 320k-px table | E4 prototype with ~100 rendered rows: 38 ms |
| Jump-scroll 334 ms at 10k | same | E4: 93 ms |
| Scroll area ~1.85× the table (596k px for a 321k table at 10k) | hidden source lines are `height: 0`, but CM6's height map estimates unmeasured lines at ~27 px each | phantom space below the table, "Measure loop restarted more than 5 times" warnings |
| Open at 100k dominated by parsing | Lezer parse of the buffer + codec decode | ≈ 0.65 s Lezer alone |

A cell commit is no longer the problem (`updateDOM` patches one cell; layout
after a patch ≈ 0). The DOM size and the height map are.

## Hard constraints

- **Layout stability is non-negotiable** (owner, from a reverted branch that
  measured DOM widths and synced them between per-row widgets). Column widths
  must never drift or jump while scrolling. So: widths are computed **from the
  data**, never read from rendered rows; all rows share **one CSS value** for
  their column template; nothing per row measures anything.
- One widget, native CSS alignment. No per-row widgets.
- Never dispatch a CM6 transaction per animation frame.
- No branch on "is this CSV" inside `tables.ts` — a facet field with a
  markdown default (rule from `preview/CLAUDE.md`, "CSV documents").
- WebKit (WKWebView) is the target engine; it decides every budget.

## Decisions at a glance

| Question | Decision |
|---|---|
| Who draws the table | A **block** `Decoration.replace` over the whole table, from a `StateField` (`tableBlockField`), only when `tableConfig.layout === 'windowed'`. `decorateTable` (plugin path) skips such tables. |
| Widget | `WindowedTableWidget`, a separate class in `preview/table-window.ts`, sharing cell/row builders, overlay, ops and navigation with `tables.ts`. Markdown's `TableWidget` is untouched. |
| Height map | Exact by construction: `estimatedHeight` = DOM height = `HEAD_H + dataRows × ROW_H + FOOT_H`, all constants. No hidden lines exist any more → no phantom space, no measure loop. |
| Rows rendered | Visible rows + 40 overscan each side (~120 rows, ≤ ~1.5k nodes) plus pinned rows. Absolutely positioned at `i × ROW_H` in a fixed-height body. |
| Scroll driver | Passive `scroll` listener on `view.scrollDOM` → one rAF → DOM-only window update. No transactions. |
| Row height | Fixed, one TS constant (`ROW_H`, ≈ 28 px, final value matched to today's single-line row in a browser). Cell text is one line, `nowrap` + ellipsis. |
| Column widths | Computed from the data in `ch` of the table's monospace font (JetBrains Mono): max display width over header + all rows, clamped to `[4ch, 40ch]`, plus padding. One `grid-template-columns` value on the root. Grow-only during a session. |
| Header | Sticky (`position: sticky; top: 0`) inside the widget; `.cm-scroller` is the only scroll container, for both axes. |
| Off-screen targets | `WidgetType.coordsAt` answers arithmetic coordinates for any position in the table → CM's own `scrollIntoView` (search, AI show, session restore, comment cards) works for unrendered rows. Navigation and the overlay use `revealTableCell` (scroll + synchronous render). |
| wrap/full toggle | Not in windowed mode (already hidden in CSV). |
| Max size | 200k rows (CM6's 7,000,000 px DOM-height scaler threshold ÷ `ROW_H`). 1M needs Phase 4. |

## 1. A block widget from a state field

### Why not keep today's decoration

Today the widget replaces the header line inline and every other line gets a
`height: 0` line decoration. CM6 only measures lines it renders; the rest are
estimated at the oracle's line height, which is where the phantom space and
the measure-loop warnings come from. There is no API to tell the height map
"these lines are zero" other than replacing them. Replacing line breaks — or
`block: true` — is rejected from a `ViewPlugin`
(`"Decorations that replace line breaks may not be specified via plugins"`),
so the decoration has to come from state.

### What changes

```ts
// table-config.ts — one new field, markdown default
type TableConfig = { maxLines: number; placeholder: string; layout: 'flow' | 'windowed' };
DEFAULT_TABLE_CONFIG = { maxLines: 1002, placeholder: '-', layout: 'flow' }; // 1000 data rows
// csvPreviewExtensions: tableConfig.of({ maxLines: Infinity, placeholder: '', layout: 'windowed' })
```

- `preview/table-block.ts` — `tableBlockField: StateField<TableBlockState>`,
  provided through `EditorView.decorations`. When `layout === 'windowed'` it
  finds top-level `Table` nodes (Lezer, the same source every other consumer
  — navigation, snap-out, spotlight — uses, so they cannot disagree with what
  is drawn) and emits, per table,
  `Decoration.replace({ widget: new WindowedTableWidget(...), block: true })`
  over `[lineAt(node.from).from, lineAt(node.to).to]`. It also holds the
  column widths (§3), so they survive widget rebuilds.
- Recomputed on: `docChanged`, syntax tree change, `aiCommentField` change,
  `tableConfig` change. Otherwise the previous `DecorationSet` is returned
  as is (no widget compare at all).
- `decorateTable` returns early when `layout === 'windowed'` — the one
  facet-driven branch in `tables.ts`. `livePreviewPlugin` stays installed in
  CSV: it still calls `noteTableUpdate` first thing in every update, which
  `updateDOM`'s identity check and the overlay's range mapping need, and its
  pass costs nothing more (the tree walk stops at `Table`).
- `EditorView.scrollMargins.of(() => ({ top: HEAD_H }))` in the CSV bundle,
  so CM scrolls targets below the sticky header, not under it.

### What it changes for caret, selection and navigation

| Area | Effect |
|---|---|
| Arrow keys in the document | Cursor motion skips the block as one unit (ArrowUp from below the table lands at its start). Same visual result as today's snap-out. |
| `table-selection.ts` snap-out, `select.cell`, `select.search` exemptions | Unchanged. Programmatic selections may still sit inside the replaced range; the listener redirects exactly as now. |
| Drawn caret | CSV already hides `.cm-cursorLayer`; the caret in a cell is the host's DOM caret. |
| Cmd+A | Selects the document; `drawSelection` may paint over the block. Accepted (it says "everything is selected"); see open question 6. |
| `view.visibleRanges` | **Excludes** state-replaced ranges (`computeVisibleRanges` skips points). In a CSV it is ~empty. Only the spotlight relied on it for table matches — see §5. |
| `posAtCoords` inside the table | Returns the block's edges, as today. Already irrelevant for clicks (`ignoreEvent() === true`); matters for `topVisibleLine` (§5). |
| Block widgets anchored inside the table (comment cards, `ask`) | Hidden by the replace. They move to the end of the table (§5). |
| Lezer partial parse at open | The table node grows as the parse advances; the windowed `updateDOM` accepts row-count changes, so the body grows without a rebuild. |

## 2. Rendering model

### DOM

```
.cm-scroller  (overflow: auto — the only scroll container, both axes)
└─ .cm-content
   └─ .cm-md-table-wrap[data-layout="windowed"]          block widget root
      │   style: --table-cols: <grid template>; --table-row-h: ROW_H px
      │   height = HEAD_H + dataRows·ROW_H + FOOT_H  (constants only)
      ├─ .cm-md-table-head      position: sticky; top: 0     height HEAD_H
      │   ├─ column gutter strip: .cm-md-table-col-ctrl, "+" add column
      │   └─ header row         display: grid; grid-template-columns: var(--table-cols)
      ├─ .cm-md-table-body      position: relative; height: dataRows·ROW_H;
      │   │                     contain: strict; zebra as repeating-linear-gradient(ROW_H)
      │   ├─ row i              position: absolute; top: i·ROW_H; height: ROW_H; same grid
      │   └─ …                  window [start, end) ∪ pinned rows
      └─ .cm-md-table-foot      "+" add row                    height FOOT_H
```

Every row — header, rendered body rows, a row rendered later — takes its
column tracks from the same `--table-cols` value. Alignment is a property of
CSS, not of any code that runs per row. The delimiter row is never rendered.

The zebra background on the body (period `2 × ROW_H`) means a region WebKit's
async scrolling shows before the window catches up looks like empty rows, not
a void.

### Window

- **Size**: `visible = ceil(clientHeight / ROW_H)` (~30–45), overscan 40 rows
  above and below → ~120 rows, ~1.5k nodes at 6 columns, independent of the
  table size.
- **Re-window threshold**: when the visible range comes within 10 rows of the
  rendered window's edge, recentre the window on it.
- **Shift is incremental**: rows still inside the new window keep their DOM;
  leaving rows are removed, entering rows are built into one fragment. Absolute
  positioning means insertion order does not matter and siblings never reflow.
  A jump (scrollbar drag) replaces the whole window: ~120 rows built in one go.
- **Pinned rows** are never removed while pinned, wherever they are: the row
  whose cell holds the open overlay, the row whose host holds focus or a live
  selection, the row being dragged. Pins are functions resolved at use time
  (the overlay's pin reads its mapped range: a row inserted above shifts its
  index).

### Scroll loop (no transactions)

1. Passive `scroll` listener on `view.scrollDOM`, registered in `toDOM`,
   removed in `destroy(dom)` (and self-removing if the root is disconnected).
2. On scroll, if no frame is pending, `requestAnimationFrame`. Scroll events
   are dispatched before rAF callbacks in the same frame, so the window is
   drawn before that frame paints.
3. In the frame: **read** body top relative to the scroller (one rect read —
   layout is clean during a scroll), compute the visible row range with pure
   arithmetic (`table-geometry.ts`), then **write**: shift the window if the
   threshold is crossed. No other reads.
4. After a shift, dispatch a DOM event `cm-md-table-window` on the root
   (bubbles). Listeners that paint on rendered cells (§5) re-run on it. This is
   how they learn about DOM that changed outside a CM update.

`view.requestMeasure` is not used for the window — it would tie the window to
CM's measure cycle, which a scroll inside one huge block does not trigger.

### Coexistence with `updateDOM`

`WindowedTableWidget.updateDOM(dom, view, from)`:

- **Same table** — the existing identity rule, shared with `TableWidget`
  through an exported helper: `from.nodeFrom` carried through
  `noteTableUpdate`'s changes with `MapMode.TrackAfter` must land on this
  widget's `nodeFrom`.
- **Compatible** = same table and same `colCount`. Unlike flow tables, the
  **row count may differ**: rows are data, not structure. Add/delete row, a
  partial parse growing, an undo — all patch.
- **Patch**: swap `model.ctx`/`model.anchors`; set the body height if the row
  count changed; set `--table-cols` if widths grew; for every **rendered**
  row (window ∪ pinned) re-render cells whose text, `from`/`to` or comment
  highlights changed (keyed by row index, so rows shifted by an insertion
  above simply show their new data); update root attributes that encode
  shape (`data-single-row`, `data-single-col` → CSS hides "−"). Rows outside
  the window are data only: nothing to patch.
- Cost is O(window × columns), whatever the table size.
- Handlers follow the existing rule: close over the model plus (row, col),
  resolve at event time.

`WindowedTableWidget.eq` holds the `Text` it was built from: equal when the
document, `nodeFrom`/`nodeTo`, the anchors and the width template are equal —
O(anchors), instead of `TableWidget.eq`'s per-cell walk (600k comparisons per
update at 100k × 6).

## 3. Geometry

### Rows

- `ROW_H`, `HEAD_H` (= column gutter + one row), `FOOT_H` are TS constants in
  `table-geometry.ts`; the widget writes `--table-row-h` inline so CSS and the
  arithmetic share one source. The app's editor font is a fixed 16 px (Cmd
  +/− is page zoom, which leaves CSS pixels alone), so no runtime probe is
  needed. Integer pixels: a fractional height drifts by a pixel every few
  rows at 100k.
- The block widget no longer sits in a `.cm-md-table-line`, so the windowed
  root restates today's computed table font explicitly: `--font-code`,
  0.9 × 0.9 of the editor's 16 px, line-height that fits `ROW_H`.

### Long and multi-line values

- Every cell, header included, is one line: `white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis`.
- A newline in a value (`<br>` in the buffer) renders as a muted `↵` glyph,
  so the row stays one line and the break is still visible.
- A cell whose display width exceeds its column gets a native `title` with the
  full value. Known arithmetically (§ below), no measurement.
- The full value is in the edit overlay. In windowed mode the overlay **does
  not grow the cell** (`showCellEditor` today writes `min-width`/`height` on
  the cell — that would break the fixed geometry): it floats over the cells
  to its right and below, with the same once-computed width
  (`cellEditWidth`) and its own auto-grown height.

### Column widths

The table font is monospace in every theme (`--font-code: 'JetBrains Mono',
'SF Mono', monospace`), so a width in characters is a width in pixels, and CSS
can resolve it with the `ch` unit — no canvas, no DOM measurement.

```
width(col) = clamp(max over header + all data rows of displayWidth(cell), 4, 40) ch + 1.6ch padding
--table-cols = var(--table-row-gutter) w(0) w(1) … w(n-1)
```

- `displayWidth(text)`: the rendered text (inline tokens without their
  markers, link text without the URL, `\|` → 1, `<br>` → 1), East Asian
  wide/fullwidth and emoji count 2, combining marks 0. Fast path for plain
  printable ASCII without `*_\`[\\<~`: the length. Pure, unit-tested.
- **Full pass, not sampled**: O(total characters) of plain JS, ~20–40 ms at
  100k × 6. Sampling would let a long value deep in the file decide nothing,
  and the result must be the same every time the file is opened.
- **When widths change** (recommended, open question 1):
  - on open: computed as above;
  - on an edit: **grow-only** — the touched lines' cells are measured (from
    `iterChangedRanges`, O(changed cells)); a column widens if one of them
    needs more, up to the cap; nothing ever narrows during the session;
  - on a structural rewrite (`replaceTable`, i.e. add/delete/move column and
    their undo — a change starting at the table's first character): full
    recompute.
  - never on scroll, resize, window shift or font load.
- Font loading: `ch` resolves against JetBrains Mono only once it is loaded.
  The CSV open path awaits `document.fonts.load('…JetBrains Mono')` before
  configuring the CSV kind (bundled woff2, a few ms), so the first paint is
  already in the final font.

### Total height and the size ceiling

`height = HEAD_H + dataRows × ROW_H + FOOT_H`. CM6 switches to its `BigScaler`
when the document is taller than 7,000,000 px and scales everything *outside*
the viewport; a single block taller than that is the viewport, and the scale
goes to zero or negative. So `dataRows × ROW_H` must stay well under 7M px:
at 28 px that is 250k rows. **Supported maximum: 200k rows.** (WebKit's own
LayoutUnit limit, ~33.5M px, is not the binding one.)

### Horizontal overflow

The root is `width: max-content` (deterministic: the head grid has only fixed
tracks). A table wider than the content column overflows `.cm-content` and
`.cm-scroller` scrolls horizontally — one scroller for both axes, which is
what keeps the sticky header working (a scroll container of its own on the
wrap would capture the sticky). No `max-width` in windowed mode.

### wrap/full

Dropped in windowed mode: there is nothing to wrap in a fixed-height row, and
"full" (no cap) can be a later change to the clamp. The ⇔ button is already
hidden in CSV; `tableModeField` is not read by the windowed widget.

## 4. Sticky header

- `.cm-md-table-head` (column gutter strip + header row) is
  `position: sticky; top: 0; z-index: 2`, with an opaque background under the
  header gradient so rows do not show through.
- Requires no `overflow` other than `visible` on any element between it and
  `.cm-scroller`. Today `.cm-md-table` has `overflow: hidden` for its rounded
  corners — in windowed mode the corners come from `border-radius` on the
  head and body boxes instead (grid boxes honour radius; the old Chrome
  problem was `display: table-row`). `overflow: clip` is not relied on (the
  app has no minimum macOS set; older WKWebViews lack it).
- The column ctrl panel (#48) lives in the sticky head, so it travels with the
  header; `createColCtrl`'s one rect read per `mouseenter` is unchanged.
- The "+" add-column button sits in the head's right edge; "+" add row in the
  foot.

## 5. Everything that finds a row or cell in the DOM

### The reveal API

`preview/table-reveal.ts`, a per-root hook registry (no import cycle:
`tables.ts` imports it, `table-window.ts` registers into it):

```ts
interface TableDomHooks {
  /** Make the cell exist and be on screen (scroll if needed, render synchronously); return its element. */
  revealCell(row: number, col: number, scroll?: 'nearest' | 'center' | false): HTMLElement | null;
  /** May opening the overlay grow the cell? Flow: yes. Windowed: no. */
  readonly growsCellOnEdit: boolean;
  /** Keep a row rendered until release() is called; `row` is resolved at use time. */
  pin(row: () => number | null): () => void;
  /** Document position of the row at a client Y, for "top visible line". */
  posAtClientY(y: number): number | null;
}
registerTableHooks(root, hooks); tableHooksFor(el); revealTableCell(view, tableFrom, row, col, scroll?)
```

Flow tables register nothing; every caller falls back to exactly today's code.
`revealCell` scrolls by writing `scrollTop`/`scrollLeft` (a scroll, not a
transaction — CM picks it up through its own scroll listener), renders the
window around the row synchronously, and returns the element; the caller's
first `getBoundingClientRect` is the only forced layout.

`coordsAt(dom, offset, side)` on the widget answers for any position in the
table: row by binary search over `ctx.rows[].from`, `y = bodyTop + i × ROW_H`,
`x` from the header cell of that column (the header is always rendered). This
is what CM's `scrollIntoView` uses for block widgets, so every
`EditorView.scrollIntoView(pos)` in the app reaches unrendered rows with no
code of its own.

### Feature by feature

| Feature | Today | Windowed |
|---|---|---|
| Overlay open (dblclick, typing in a parked cell) | on a rendered cell | Unchanged — only rendered cells receive events. `showCellEditor` asks `tableHooksFor(cellEl)`: no cell growth when `growsCellOnEdit` is false; pins the row through a function reading the `OverlayRange`. |
| Overlay range mapping | `noteTableUpdate`, `MapMode.TrackDel`, doc identity | Unchanged. It never read the DOM, which is why it survives windowing. |
| Overlay while scrolling | stays at its fixed position | Phase 1: pinned row keeps the cell (and its editing class) alive. Phase 2: the overlay follows its row from arithmetic on each scroll frame and is hidden (focus kept) while the row is outside the body's visible area or under the sticky header. |
| Tab / Enter / Mod-Shift-Enter across the window edge | `openCellEditorAt` queries `[data-source-from]` | `openCellEditorAt` calls `revealTableCell(view, ctx.nodeFrom, row, col, 'nearest')` first, then queries as today. Tab also reveals horizontally on wide tables. The rAF retry stays for flow tables. |
| Parked caret / click → caret (#53) | cell handlers via the model | Unchanged on rendered cells. A row whose host holds focus or the DOM caret is pinned, so scrolling away and back keeps the caret. |
| Search highlights in cells (`widget-matches.ts`) | DOM walk over rendered cells | Same walk (it already only sees rendered cells). Also re-schedules on `cm-md-table-window`. |
| Spotlight (`spotlight.ts`) | holes from `visibleRanges` + `widgetRects` | `visibleRanges` excludes the block, so: (a) visible matches = `visibleRanges` ∪ source ranges of rendered rows (from the same `[data-source-from]` walk as `widget-matches`, a shared helper); (b) `widgetRects` finds cells through `contentDOM`, not `closest('.cm-line')` (a block widget has none); (c) the veil sheet is clamped to the visible scroller area ± one screen when the viewport is taller than ~20 screens (today it would be an SVG mask as tall as the table — 5.6M px at 200k); (d) on `cm-md-table-window` while `spotlightOn`, one `remeasureVeil`, trailing-debounced 100 ms. |
| Cmd+G to a far match | selection + `scrollIntoView` | Same transaction; `coordsAt` gives the row, CM scrolls, the window renders in that frame, highlights repaint on the window event. `select.search` snap-out exemption unchanged. |
| Comment highlights in cells (#62) | `cellHighlights` in `renderCellContent` | Same, for rendered rows. `CommentAttentionPlugin.syncAnchors` also runs on `cm-md-table-window`, so a span rendered later gets the attention class. |
| Comment cards / `ask` widgets anchored in a row | block widget at the row line's end — stacks under the table | Would be swallowed by the replace. `ai-comment.ts`/`ai-ask.ts` place the widget at `tableBlockEndAt(state, pos) ?? lineAt(pos).to` (helper from `table-block.ts`, `null` without the field) — the same visual place as today. Card click → `scrollIntoView(anchor)` → `coordsAt`. |
| AI `show` / pulse, AI-mark navigation | scroll to a line; pulse on a hidden line (invisible) | Scrolling now lands on the row (`coordsAt`). The pulse stays invisible, as today; painting it on the row the #62 way is Phase 2 (optional). |
| Session top line (`topVisibleLine`, App.svelte) | `posAtCoords` at the scroller's top | `posAtCoords` returns the block edge → always line 1. Use `tableHooksAt(...)?.posAtClientY(y) ?? view.posAtCoords(...)`. Restore (`scrollIntoView(line.from, 'start')`) already works through `coordsAt`. |
| Row drag | `getRowWraps` reads every row's rect | Windowed drag in `table-window.ts`: drop index `= clamp(round((clientY − bodyTop) / ROW_H), 0, n)`, indicator from the same arithmetic, no rect per row. **Autoscroll**: pointer within 48 px of the scroller's bottom or of the sticky head's bottom → rAF loop scrolls proportionally (cap ~40 px/frame); the window follows through the normal scroll path; wheel during a drag works too. Escape cancels. The dragged row is pinned. |
| Drop / delete row | `replaceTable` (whole node, re-padded) | **Line-level** in windowed mode: delete = remove the line with its newline; move = one transaction deleting the line and inserting it at the target. Keeps Lezer and `csvEditGuard` incremental and the first character untouched, so `updateDOM` patches. A whole-node rewrite at 100k is a full reparse (~0.65 s) plus a full guard check. Ops are injected into the shared ctrl-cell builder; flow passes today's. |
| Add row (+, Mod-Shift-Enter) | line insert | Unchanged; the new row is revealed (navigation opens the overlay through `revealTableCell`). |
| Add / delete / move column | `replaceTable` | Unchanged (every line changes anyway). O(n): budgeted, not optimised in Phase 1. Triggers the full width recompute. |
| Hover controls, delete-row "−" | per row, built with the row | Built with each rendered row. "−" visibility from root attributes, not from shape read at build time. |
| Column ctrl panel (#48) | in the wrap, JS `left` from header cell rect | In the sticky head; otherwise unchanged. |
| Mouse selection across many screens | does not exist: each cell is its own editing host (#31), a drag selects inside one cell | Unchanged; the host's row is pinned while the selection lives. |
| Copy (Cmd+C) | in a host: visible cell text; a document selection (Cmd+A): the markdown source | Unchanged. A CSV/TSV copy is a separate feature (open question 6). |
| Undo / redo, external reload | patch or rebuild | Row-level undo patches. A reload replaces the whole node → identity fails → `toDOM` (cheap now: one window). Same height → scroll position kept. |

## 6. Performance budget

Targets in WebKit, 6 columns, release-like build (Vite production bundle for
Playwright; `npm run build:dev` + MCP bridge for the final WKWebView check):

| Metric | 10k | 100k | 200k (cap) | How measured |
|---|---|---|---|---|
| Open: disk text → table painted | ≤ 0.3 s | ≤ 1.5 s | ≤ 3 s | `decodeFromDisk` + state create + double rAF after `setState`, split into decode / field / first layout |
| Cell commit → next overlay open (Enter) | ≤ 30 ms | ≤ 100 ms | ≤ 200 ms | dispatch → overlay focused, double rAF |
| Scroll frame, p90 during a sweep | ≤ 16.7 ms | ≤ 16.7 ms | ≤ 16.7 ms | `scrollTop += 200` per rAF across the table, rAF deltas |
| Jump to row (scrollbar / `scrollTop` to a random row) | ≤ 50 ms | ≤ 50 ms | ≤ 50 ms | write → row present in window, double rAF |
| Cmd+G to a match 50k rows away | — | ≤ 100 ms | ≤ 150 ms | dispatch → current-match highlight painted |
| Delete / move row | ≤ 30 ms | ≤ 100 ms | ≤ 200 ms | dispatch → double rAF |
| Add / delete / move column | ≤ 0.3 s | ≤ 1.5 s | ≤ 3 s | same |
| DOM nodes in the widget | ≤ 2k | ≤ 2k | ≤ 2k | `querySelectorAll('*')` on the root |
| Scroll height − table height | < `ROW_H` | < `ROW_H` | < `ROW_H` | `scrollDOM.scrollHeight` vs root height + padding |
| "Measure loop restarted" warnings | 0 | 0 | 0 | console capture |

Where the remaining cost is at 100k–200k, per commit: `buildTableContext`
(O(n), ~5 ms per 10k rows) in the field, Lezer incremental reparse, the
guard's incremental check (~1 ms). Per open: Lezer (≈ 0.65 s per 100k), codec
decode, the guard's first full check (~110 ms at 100k), widths (~30 ms).
Phase 3 removes the O(n) per commit if 200k misses its budget.

Harness: the perf job's `harness.js`/`run.mjs` (Playwright WebKit against
`npm run dev`, CSV injected through the codec) are the starting point; the
windowed suite lands in the repo next to the feature so a regression is
re-measurable. Each phase ends with a run at 10k/100k/200k recorded in this
spec, the way the CSV spec records its WKWebView numbers.

**The cap.** `CSV_TABLE_MAX_ROWS` stays 20 000 until Phase 1 meets the 100k
column above, then becomes 100 000; 200 000 after Phase 3. Never above 200k
without Phase 4 — the 7M px ceiling is a hard failure, not a slowdown. Above
the cap a CSV keeps opening as plain text with the existing refusal.

## 7. Markdown stays on today's path

### Code structure

| File | Role | Markdown impact |
|---|---|---|
| `preview/table-dom.ts` (new, Phase 0) | `renderCellContent`, `cellHighlights`, `buildCell`, `mkBtn`, ctrl cells, col ctrl — **moved verbatim** out of `tables.ts` | None: a move; existing tests pin it |
| `preview/table-geometry.ts` (new) | Pure: constants, `displayWidth`, `columnWidths`, `windowFor`, `rowAt`, `dropIndexAt`, `autoscrollSpeed` | None |
| `preview/table-reveal.ts` (new) | Hook registry, `revealTableCell`, `cm-md-table-window` event name | No hooks registered → callers do what they do today |
| `preview/table-window.ts` (new) | `WindowedTableWidget`, window loop, pins, windowed drag, line-level row ops, `coordsAt` | Not loaded by markdown state |
| `preview/table-block.ts` (new) | `tableBlockField`, widths state, `tableBlockEndAt` | Not installed for markdown; helper returns `null` |
| `preview/table-config.ts` | `layout: 'flow' \| 'windowed'`, default `'flow'` | Default = today |
| `preview/tables.ts` | `decorateTable` early return on `'windowed'`; `openCellEditorAt` and `showCellEditor` consult the hooks; identity helper exported | Hooks absent → identical code path |
| `search/spotlight.ts`, `search/widget-matches.ts`, `ai-comment.ts`, `ai-ask.ts`, `App.svelte` | §5 additions | Each falls back to today's behaviour when no windowed table exists; the veil clamp only engages for a viewport > ~20 screens |
| `styles/editor.css` | Windowed rules scoped under `[data-layout="windowed"]` | Flow selectors untouched |

### Invariants

- `TableWidget` (`toDOM`, `updateDOM`, `eq`) is not modified.
- No `if csv` anywhere in `preview/`. The only switch is
  `tableConfig.layout`; the CSV specifics (one table per buffer, the cap)
  stay in `src/lib/csv/`.
- Existing suites (`tables.test.ts`, `table-update-dom.test.ts`,
  `preview-rebuild.test.ts`, `table-config*.test.ts`, search, comments) pass
  unchanged. A new test asserts a markdown table under the default config
  renders every row, no `data-layout`, no block decoration.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Sticky header broken by an `overflow` ancestor in some WKWebView | §4 rules; a browser test asserts the head's top equals the scroller's top after scrolling 1000 rows. |
| WebKit async (momentum) scrolling outruns the main thread → blank body for a frame | Overscan 40, zebra background on the body, measure blank frames in the sweep; raise overscan if needed. |
| Exceeding CM6's 7M px scaler threshold breaks everything at once | Cap 200k at `ROW_H` 28; a unit test asserts `200_000 × ROW_H + HEAD_H + FOOT_H < 6.5e6`. |
| A row DOM recycled under the open overlay, a focused host or a live selection | Pins; tests that scroll 500 rows away and back with each of the three. |
| Handlers capturing positions (the `updateDOM` lesson) | Same model + (row, col) rule; `table-update-dom`-style jsdom cases for every windowed handler after a patched edit and after a row inserted above the window. |
| Listeners that paint on cells miss DOM changed outside a CM update | The `cm-md-table-window` event; a test per subscriber (widget matches, spotlight, comment attention). |
| `ch` widths approximate for CJK/emoji in fallback fonts, or a theme with a proportional `--font-code` | Ellipsis + `title`; never a misalignment, since every row shares the template. |
| Column-op cost at 200k (whole-node rewrite + full reparse) | Budgeted (≤ 3 s); Phase 3 can drop `markdownTable` re-padding for windowed tables if it dominates. |
| Text selection in a truncated (nowrap) host scrolls the host's content sideways | Accept for v1; observe in WebKit. |
| Memory at 200k (`TableContext` holds every cell) | Measure in Phase 1; lazy context is Phase 4 material. |
| Screen readers see only rendered rows | Accepted for v1; note in docs. |

## 9. Open questions for the owner

1. **Column width after edits**: grow-only on commit, capped, never narrowing
   in a session (recommended) — or frozen at open (overflow shows an
   ellipsis), or recomputed every time (columns can shrink)?
2. **Width cap** of 40 characters with ellipsis + native tooltip for the full
   value — right number, and is the tooltip wanted?
3. **Multi-line values** on one line with a `↵` marker (full text in the
   overlay) — acceptable? Taller rows are not compatible with fixed geometry.
4. **Is 1M rows a real requirement?** The design tops out at 200k. 1M needs
   Phase 4 (no Lezer for CSV, a lazy table context, a compressed scrollbar
   mapping past 7M px) — significant work.
5. **Cap schedule**: 100k after Phase 1, 200k after Phase 3 — or keep 20k
   until everything ships?
6. **Cmd+A → Cmd+C** in a CSV copies the markdown source today. Want a
   CSV/TSV copy (separate feature)?
7. **Wide CSVs** scroll the whole editor horizontally (one scroller keeps the
   header sticky). OK, and is a sticky row-control column wanted later?

## 10. Phases

| Phase | Content | Ships when |
|---|---|---|
| **0. Extraction** | Move cell/row/ctrl builders to `table-dom.ts`; inject row ops into the ctrl-cell builder. No behaviour change. | All suites green, browser spot check of a markdown table. |
| **1. Windowed CSV (MVP)** | `layout` field; `tableBlockField`; `WindowedTableWidget` with fixed geometry, data-derived widths (grow-only), sticky header, scroll window, pins, windowed `updateDOM`/`eq`, `coordsAt`, `scrollMargins`; reveal API wired into navigation and the overlay (no cell growth); line-level delete/move row; arithmetic drag (no autoscroll yet); `cm-md-table-window` + subscribers (widget matches, spotlight fixes and veil clamp, comment attention); comment/ask cards at the table end; `topVisibleLine`. | Budgets met at 10k and 100k in WebKit; phantom space and measure-loop warnings gone; column-stability test green (header and body cell `x`/`width` identical across 50 scroll positions); cap → 100k. |
| **2. Interaction polish** | Drag autoscroll; overlay follows its row while scrolling; horizontal reveal for Tab; `title` on truncated cells; optional AI pulse painted on the row. | Browser tests for each. |
| **3. 200k** | Field incremental: reuse the previous `TableContext` for untouched lines (or lazy rows) so a commit is not O(n); measure and, if needed, skip re-padding in column ops. | 200k column of the budget met; cap → 200k. |
| **4. Beyond 200k (only if Q4 says yes)** | Table locator facet so navigation/snap-out/spotlight stop needing Lezer; CSV on a plain-text language (removes the parse from open); lazy context; compressed scroll mapping above the 7M px ceiling. | Separate spec. |

## Testing

- **Vitest, pure** (`table-geometry.ts`): `displayWidth` (ASCII fast path,
  markers, links, `\|`, `<br>`, CJK, emoji, combining), `columnWidths`
  (header counts, clamp, grow-only, recompute on rewrite), `windowFor`
  (edges, threshold, tiny tables), `dropIndexAt`, `autoscrollSpeed`, the 7M
  px guard.
- **Vitest + jsdom, real `EditorView`** (like `table-update-dom.test.ts`; no
  layout, but geometry is arithmetic): block decoration only under
  `'windowed'`; `estimatedHeight` formula; `coordsAt` for an unrendered row;
  windowed `updateDOM` patches across add/delete row and refuses another
  table's DOM; every handler after a patch and after a row inserted above the
  window; pins; `revealTableCell` renders a far row synchronously; line-level
  delete/move round-trip through undo; comment card placement; markdown
  default unchanged.
- **Playwright WebKit (`npm run dev`)**: no phantom space; sticky header;
  column stability across scroll; Enter/Tab across the window edge;
  Cmd+G to a far match with its highlight; spotlight holes in rendered rows;
  drag with autoscroll to a far row; overlay survives scrolling away and back;
  the budget table at 10k/100k/200k.
- **`dev:app` + MCP bridge (WKWebView)**: open a real 100k-row `;`/CRLF/BOM
  file, edit, add/delete/move a row, diff the bytes on disk; re-measure open,
  commit and the scroll sweep; session restore returns to the same row.
