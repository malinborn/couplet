# live-render — the permanently-hidden-markup editor mode

Markdown markers stay hidden while the caret is on the element, Notion-style.
This directory holds only what is specific to that mode; the rendering itself
is the shared decoration layer in `../preview/`.

Read `../preview/CLAUDE.md` first for the decoration rules and the reveal
policy — this file assumes them.

## How it is installed

`liveRenderExtensions()` (`index.ts`) is added to `previewCompartment`
(`../setup.ts:67`) by the effect in `App.svelte`, **only** while the selected
engine is `live-render`. In live-preview none of it is in the editor state at
all, which is what makes the existing mode safe by construction rather than by
review discipline.

The flavour facet decides whether markup is *revealed*; this bundle decides how
*editing* behaves. They are separate and both are needed.

| File | Concern |
|------|---------|
| `index.ts` | The bundle, and the only place precedence is documented for callers |
| `atomic.ts` | Hidden marker ranges, `EditorView.atomicRanges`, the caret transaction filter |
| `block-format.ts` | Backspace at block start strips heading / list / quote formatting |
| `inline-continuation.ts` | Typing at a span boundary continues the format; `isLiveRenderActive` |
| `heading-input.ts` | Supplies the space that makes a `#` run a heading |
| `format-commands.ts` | Tree-aware inline toggles used by both the toolbar and the shortcuts |
| `selection-toolbar.ts` | Floating inline-format toolbar; also the only place that can see a selection inside a widget |
| `cell-anchor.ts` | Rendered table-cell offsets → source offsets, for commenting on cell text |
| `inspector.ts` / `inspector-model.ts` | Link URL and fenced-code language |
| `effects.ts` | `openInspectorFor`, the toolbar → inspector handoff |

## Gotchas

### Atomicity is two mechanisms, and the second one is not optional

`EditorView.atomicRanges` is consulted **only** by the caret-motion helpers
(`moveByChar`, `moveByGroup`, `moveVertically`), by `MouseSelection`, by
`applyDOMChange` when `userEvent == "select.pointer"`, and by `deleteBy` via
`skipAtomic`. There is no transaction filter anywhere in `@codemirror/view`.

So any programmatic `dispatch({selection})` walks straight into a hidden
marker, and the next keystroke writes corrupt source. This app already has five
such callers: `@codemirror/search`, session restore in `App.svelte`, `history()`
restoring a selection on undo, `../preview/table-selection.ts`, and the
slash-command / hover-menu insertions. `caretNormalizeFilter`
(`atomic.ts:333`) is what covers them.

The filter consults the same `RangeSet` as the atomic provider rather than
resolving the node at a point. `decorateLink` hides `](url)` as one span wider
than any `LinkMark`, so a caret inside the URL text resolves to a `URL` node
that no list of marker names would catch.

### `hiddenMarkRanges` and `plugin.ts` must agree, exactly

`hiddenMarkRanges` (`atomic.ts:253`) deliberately mirrors the traversal in
`../preview/plugin.ts` — same switch, same descend-or-`return false`. Change one
and you must change the other.

Both failure directions are bad, and both are quiet:

- **Hidden but not atomic** — the caret walks into text that is not drawn, and
  typing lands somewhere the user cannot see.
- **Atomic but not hidden** — the caret refuses to enter text that is plainly
  visible on screen.

Concrete cases that live in this seam: fenced-code fences are hidden with a
zero-height *line* decoration, not a replace, so the text is really there and
must **not** be atomic; the ordered-list marker is never replaced by any
decorator; table cell contents are rendered by a separate path entirely.

### Backspace needs `Prec.highest`; Escape only needs `Prec.high`

Backspace appears in the view's `PendingKeys` table paired with
`inputType: "deleteContentBackward"`. On a contenteditable it is therefore not
resolved from `keydown` alone: the native edit is allowed to land and is
reconciled afterwards, with the key re-dispatched so bindings still get a turn.

At `Prec.high` the block-format command was **never entered**, and the failure
was not a clean fall-through — the DOM-derived change was applied instead.
With the bullet rendered as a widget, that reconciliation rewrote `- b` as
`  b`: a silent outdent, text still inside the list item. Every unit test passed
throughout, because they call the pure function directly.

Escape carries no `inputType` and works fine at `Prec.high`. Do not "simplify"
the two to match.

Both keymaps carry their precedence at the source so a caller cannot forget it.
The main keymap is registered at `../setup.ts:55`, before the compartment at
`:67`, and CM6 tries equal-precedence handlers in registration order.

### The caret boundary paints two offsets at one pixel

For `**bold**`, offset 6 (before the closing marker) and offset 8 (after it)
render at the same screen position, because the markers are zero-width and
absent from the DOM. Typing at 6 lands inside the bold, at 8 outside.

This is why the mode has **one canonical caret position** — the filter
normalises outward — and why an `inputHandler` redirects insertion back inside.
It is also why **the arrow keys are not an exit**: at that boundary an arrow
press moves the caret two offsets and zero pixels, which is indistinguishable
from a dead key. At end of line there is nowhere for it to go at all.

Exit is Escape or the Cmd+B family, and a state field remembers the suppressed
boundary so a second keystroke still lands outside. If you add another exit
gesture, it goes through that field.

### Leaving a fenced code block (`../code-block-exit.ts`)

A code block has no visible edge in this mode — the fences are hidden by a
zero-height *line* decoration — so Enter only ever added lines inside it (#52).

Two Enters at the end of the block leave it: Enter on a blank *last content
line* that has at least one content line above it deletes that line and puts the
caret below the closing fence. Mid-block Enter never exits, so a blank line
between two functions stays typable. Shift+Enter always inserts and is
deliberately **not** bound — `standardKeymap` already carries
`{key: "Enter", …, shift: insertNewlineAndIndent}`, and a binding without a
`shift` property is never consulted for Shift+Enter.

Two things about it are worth knowing before changing it:

- **The "only at the end" qualifier does not save the double-Enter reflex while
  you are writing.** Top-down authoring happens at the end of the block by
  definition, so `a` Enter Enter `b` ejects and puts `b` in a paragraph. It is
  visible immediately and one Cmd+Z undoes it, and no Enter-count rule fixes it
  (an exit after N blanks breaks whoever wanted N). Measured by typing, not
  reasoned about.
- **The arrow exit is live-render only.** ArrowDown on the last content line and
  ArrowUp on the first one skip the hidden fence line, because here the default
  motion parks the caret on a zero-height line where it is invisible. In
  live-preview `fencedCode` is `'on-cursor'`, so those lines are visible text
  under the caret and must stay reachable — hence the divergence. The Enter exit
  itself is engine-wide and registered in `../setup.ts`.

Escape was considered as the secondary hatch and rejected: it already means
"leave the inline format span" here, and elsewhere it clears AI highlights and
closes panels.

### `keybindings.ts` is shared with live-preview

`Mod-b` / `Mod-i` / `Mod-Shift-x` live in `../keybindings.ts`, which both modes
use. Anything mode-specific there must be gated on
`isLiveRenderActive(state)` (`inline-continuation.ts`) — it checks for a state
field only this bundle installs.

Swallowing a key unconditionally, or picking a different command, changes
live-preview. `keybindings.ts:70` is the gate; `continuationFormatExitSpec`
has the same guard for the same reason.

### Emphasis is `*`, never `_`

CommonMark's flanking rules stop `_` from opening or closing emphasis inside a
word. A `_`-wrapped partial word produced no `Emphasis` node at all, so the
unwrap path found nothing to remove and every further click wrapped again —
`_x_`, then `__x__`, which is *strong*, not emphasis. It also has to match what
`Mod-i` inserts, or the toolbar and the shortcut disagree.

### Never use a text heuristic to toggle inline formatting

`toggleWrap` in `../keybindings.ts` compares the characters around the
selection. With `hello` selected inside `**hello**` it sees one asterisk on
each side, reads that as already-wrapped, and strips one from each — bold
becomes italic. The reverse order does not trip the same test, which is what
made the bug look arbitrary.

`format-commands.ts` consults the syntax tree instead and removes a span by
deleting its mark children. Use it. `toggleWrap` stays only because
live-preview depends on its current behaviour.

Note that Lezer names the markers of *both* `Emphasis` and `StrongEmphasis`
`EmphasisMark` — the difference is the mark's text length. Match on the node
name, not the mark name.

### The toolbar and the inspector need opposite focus rules

The toolbar's buttons use `mousedown` with `preventDefault()`, so DOM focus
never leaves the editor and the selection survives the click. The inspector's
input **must** take real focus — that is the whole point of it being reachable
by keyboard — so `view.hasFocus` cannot be a close signal there.

The toolbar's outside-click handler must ignore clicks **inside the editor**.
A drag-select fires `selectionSet` on `mousemove`, so the listener is armed
before `mouseup`, and the trailing click of the drag was closing the toolbar on
the very selection that opened it. Deferring registration by a macrotask does
not help. Clicks inside the editor are already governed by the selection: the
plugin hides the toolbar when the selection collapses.

### `view.hasFocus` is not the question any more

A selection inside a table cell lives in a nested editing host (#31), so
`activeElement` is the cell, not `contentDOM`, and `view.hasFocus` — which
requires the latter — is `false`. Worse, CM6 never processes the drag at all:
the widget returns `true` from `ignoreEvent`, so `state.selection` still holds
whatever it held before, *stale rather than empty*. Measured: `hasFocus: false`,
`activeEl: cm-md-table-celltext`, `state.selection` still on the previous prose
selection.

So the toolbar asks two things instead (`currentTarget`):

- **Is focus in this editor?** — the window has focus, and the focused element
  is inside a host (`[data-widget-text-host]`) that is inside this `view.dom`.
  Deleting the focus test rather than widening it would pop the toolbar up over
  a stale selection while the user is in another window or another app; all
  three failure modes were driven in a browser.
- **Where is the selection?** — a live host selection outranks
  `state.selection`, and produces a comment-only toolbar. The format commands
  edit the document through the selection and there is nothing here for them to
  edit; rewriting a cell's source from a mapped range is a separate feature.

A host selection also fires no `ViewUpdate`, in either direction, so the plugin
listens to `selectionchange` and to the window's `blur` as well as `update()`.
All three funnel into one `sync()`.

What a comment on cell text anchors to is decided in `cell-anchor.ts`: the
**source** of the selected span, with formatted spans taken whole. Anything else
fails the re-anchor search on the next open — the quote has to be findable in
the file, and `and sweet` is not in `**and** sweet`.

Known gap: the in-document anchor highlight lands on a table data line, which is
zero-height, so the mark is invisible. The card's excerpt carries the quote.
Highlighting inside the rendered cell would mean teaching `tables.ts` about
comment ranges.

### A task item is `Task`, not `Link`

The design doc claimed `- [x] done` collides with link parsing. It does not:
`markdownLanguage` already bundles GFM, so it parses as `Task > TaskMarker` and
never reaches a `Link` node.

The real lookalike is `- [x](url) text`. `TaskList.parseBlock` requires
whitespace after the bracket, so that parses as a plain inline `Link`, while
`../preview/lists.ts` still draws a checkbox over it from a text-only regex —
which is why `atomic.ts` excludes it explicitly. That same regex is
case-**sensitive**: `[X]` renders no checkbox at all.

### Mermaid stays `'on-cursor'`

Reverting to the fenced source is the only way to edit a diagram. Hiding it
permanently would require a full nested editor in the inspector, which is out
of scope, so `LIVE_RENDER` pins mermaid to `'on-cursor'` and the inspector
skips mermaid fences rather than offering a redundant language picker.

### The toolbar's hotkey captions come out of the keymap

`INLINE_FORMAT_BINDINGS` in `../keybindings.ts` is the one list: the `keymap`
is built from it, and the tooltips (#56) render their key half from it through
`../hotkey-label.ts`. A second, hand-kept caption table is exactly the kind of
duplication that stays wrong silently — nothing in the app ever compares a
tooltip against a keymap.

One measured trap lives in that helper: `navigator.userAgentData.platform`
answers `"macOS"`, lowercase `m`, so the obvious `/Mac/` test reads a Mac as a
PC and captions every button `Ctrl+B`. The legacy `navigator.platform` beside it
says `MacIntel`, which is what keeps the mistake invisible anywhere the new API
is missing.

Buttons with no binding (`</>`, 💬) still get a tooltip carrying just the
action name — they are the two least legible things in the row, and the tooltip
is the only place that ever says what they are.

## Known limitations

These are honest properties of the approach, not open bugs. Do not "fix" them
by re-introducing cursor-based reveal — that would undo the mode.

- **Search runs against the source.** `boldtext` inside `**bold**text` is
  unfindable, and searching `**` yields hits that are not rendered. A real fix
  needs a search index over the visible text.
- **Hiding markers moves the reflow rather than removing it.** A marker is only
  hidden once Lezer has a completed node, so while typing `**bol` you see raw
  text, and four characters vanish at once when the closing `*` lands.
- **Splitting an ordered list does not renumber.** The second list restarts at
  its own number.
- **IME is unverified.** There is a known CM6 Safari bug on exactly this
  configuration — a `Decoration.mark` containing several `Decoration.replace`,
  which is literally `../preview/inline.ts` — and Tauri on macOS is WKWebView.
  Marijn's patch does not close the case where a widget is added in front of
  the composition, which is what this mode does while typing.

## Testing

- `npx vitest run --dir src`. **Not** `npm run test` — it picks up stale copies
  under `.claude/worktrees/`.
- There is no jsdom in this project's vitest setup and no existing test builds
  a real `EditorView`. So every module here splits pure logic from the DOM or
  view layer, and the tests exercise the pure half: `computeBlockFormatRemoval`,
  `continuationRedirect`, `headingSpaceRedirect`, `detectInspectorTarget`,
  `hiddenMarkRanges`. Keep that split when adding behaviour.
- **Anything routed through a keymap or an inputHandler cannot be unit-tested
  here.** Both the `Prec` bug and the flavour-switch bug had green suites. Drive
  the real app.

### Driving the real app

`npm run dev:app` builds under a renamed identifier (`md-mini-dev`,
`com.md-mini.dev`) with its own data directory, so it cannot disturb an
installed release. It exposes the MCP bridge on port 9223 in debug builds.
Never use `npm run tauri dev` or `npm run tauri build` for this.

Three traps cost real time here:

1. **`document.hasFocus()`.** CM6's `view.hasFocus` is false whenever the OS
   window is not frontmost, no matter what you focus programmatically. Plugins
   that hide on blur — the toolbar — will therefore never appear while you
   probe from a background window. `view.plugins` and its constructor names are
   a reliable way to check a plugin is installed regardless of focus.
2. **Duplicate modules.** A dynamic `import('/src/…')` from the devtools can
   return a *different* module instance than the running app holds, so a
   `StateField` or `Facet` imported that way will not match the one in the
   state, and `state.field(f, false)` returns `undefined` for a field that is
   actually installed. Reading a facet's *value* out of the state is safe;
   asserting the absence of a field via an outside import is not.
3. **Vite module caching.** After editing a file, `import('…/index.ts?v=x')`
   re-fetches that module but its transitive imports stay cached. Reload the
   webview instead.

### Driving it in a plain browser — the mode does not turn on by itself

`npm run dev` + Playwright is the cheaper route, and it has a trap of its own
that silently measures **the wrong mode**.

Setting `localStorage['md-mini:engine'] = '"live-render"'` is not enough.
Without Tauri, the first `$effect` in `App.svelte` throws on
`__TAURI_INTERNALS__.metadata`, Svelte never reaches the effect that
reconfigures `previewCompartment`, and the editor stays on the compartment's
default — `livePreviewPlugin` alone, i.e. live-preview. Everything then looks
plausible: the document renders, markers are hidden while the caret is
elsewhere, and a probe concludes the mode works or does not.

So stub `window.__TAURI_INTERNALS__` (`metadata`, `transformCallback`,
`invoke`) in an init script before the page loads, and then **assert the mode
two ways** before measuring anything:

- put the caret inside `**bold**` and check the `**` did *not* reappear — in
  live-preview they do;
- look for `SelectionToolbarPlugin` and `InspectorPlugin` in `view.plugins`.
  They are the only ViewPlugins this bundle contributes, so their absence is
  proof the bundle is not installed.

Reach the view at `document.querySelector('.cm-content').cmTile.root.view`,
and launch with `chromium.launch({ channel: 'chrome' })` — the cached
chromium build lags the Playwright CLI in this repo.
