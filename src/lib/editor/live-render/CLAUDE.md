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
| `atomic.ts` | Hidden marker ranges, the marker **pairs**, `EditorView.atomicRanges`, the caret transaction filter |
| `markup-repair.ts` | The transaction filter that keeps a torn marker pair from reaching the file |
| `markup-delete.ts` | Backspace / Delete at a span edge, expressed as "the character next to the caret on screen" |
| `block-format.ts` | Backspace at block start strips heading / list / quote formatting |
| `inline-continuation.ts` | Typing at a span boundary continues the format; `isLiveRenderActive` |
| `heading-input.ts` | Supplies the space that makes a `#` run a heading |
| `format-commands.ts` | Tree-aware inline toggles used by both the toolbar and the shortcuts |
| `selection-toolbar.ts` | Floating inline-format toolbar; also the only place that can see a selection inside a widget |
| `cell-anchor.ts` | Rendered table-cell offsets → source offsets, for commenting on cell text |
| `../cell-edit-session.ts` | The open cell edit overlay, published as neutral ground between `preview/tables.ts` and this toolbar |
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

### Atomicity protects the caret; it does not protect the edit

This is the whole of #32, and it is worth stating as a separate fact because for
a long time the mode looked finished without it: `atomic.ts` normalises
**positions**, and nothing in it ever looked at `tr.changes`. So the caret was
always in a legal place, and an edit made *from* that legal place still tore
markup in half — silently, because the markers are hidden, so the user only
found out when bare `**` appeared in a document they believed was prose.

Worse, the tearing was caused by the caret protection working correctly:
`skipAtomic` widens a Backspace at offset 18 to cover the whole closing `**`,
which is exactly right as caret policy and exactly what produced
`Абзац с **жирным словом.`

Editing therefore takes **two more** mechanisms, and they answer different
questions:

| | question | where |
|---|---|---|
| `markup-delete.ts` | what did the user *mean*? | keymap, `Prec.highest` |
| `markup-repair.ts` | is the result still valid markdown? | `transactionFilter` |

Neither can do the other's job, and the reason is concrete. By the time a
transaction exists, a Backspace at 18 reads as "delete `**`", and the only
well-formed repair of that is to put the `**` back — a Backspace that does
nothing. Intent survives only at the key. Conversely, edits arrive from
`applyDOMChange`, paste, drag-and-drop, `replaceSelection` in app code and
`@codemirror/commands`, so a keymap alone cannot hold an invariant.

#### The discriminator

§5.1 of the spec names the trap: a naive "markers may not be deleted" rule
blocks deleting a bold word. What distinguishes the two cases is **the shape of
the change**, per pair — not the user event, not the key:

- the change touches **both** markers → the span is being removed as a unit
  (select-and-delete, select-and-replace, a whole-document rewrite). Leave it.
- the change touches **exactly one** → the pair was torn. Repair it.

And a torn pair is repaired by what *survives*, never by what was intended: if
content remains on the surviving side the missing marker is written back next to
it, and if nothing remains the surviving marker goes too. That is why it works
identically for a paste the layer has never seen before.

Because it keys off shape and not intent, it also catches the case the delete
keymap structurally cannot: erasing a bold word one character at a time ends
with an ordinary deletion of the last content character, with no marker anywhere
near the caret — and an empty `****` is literal visible text.

#### Three things about the filter that are not negotiable

- **Undo and redo are exempt** (`tr.isUserEvent('undo')`). History replays the
  *repaired* change's own inverse, which restores a well-formed document by
  construction — but that inverse deletes marker text, which the filter reads as
  a pair being torn and writes the markers straight back, so undo stops undoing.
  Measured: undo of a repaired Enter-inside-bold produced `**жир****ным**`.
- **It must run before `caretNormalizeFilter`.** CM6 applies transaction filters
  in **reverse** facet order, so it is registered *after* it (in `index.ts`, not
  in `atomic.ts` — the repair layer imports `markupModelField`, and registering
  it next to the field would be a cycle).
- **It returns a plain spec, never a `Transaction`.** `filterTransaction` re-runs
  a returned `Transaction` through the whole chain; a spec is resolved with
  filtering off, so it cannot loop. Same reason `caretNormalizeFilter` does it.

#### Pairs come from the same walk as the hidden spans

`collectMarkupModel` emits hidden spans **and** `MarkupPair[]` in one traversal,
cached together in `markupModelField`. A second walk would be a third thing to
keep in step with `preview/plugin.ts`, and the seam is silent in both directions
(see the next section). A link's pair also has to carry `](url)` whole as its
`closeText`, matching what `decorateLink` hides — re-inserting anything less
turns a repaired link into plain text.

### Enter inside a span, and why it is a split

A marker pair cannot straddle a line break: `**жир\nным**` is not bold, it is
two lines of literal asterisks. So any insertion carrying a newline into a span
closes it before the break and reopens it after (`**жир**` ⏎ `**ным**`), and at
the *edge* of the content moves outside the span instead — closing and reopening
there would only produce an empty `****`. A link splits by repeating its target,
which is verbose but keeps both halves links.

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

What is *not* obvious, and what #32 turned on, is that **the two offsets are not
reached by the same gestures**. Measured in a browser, on
`Абзац с **жирным** словом.` (content 10..16, closing marker 16..18):

| how the caret gets there | offset | so typing goes |
|---|---|---|
| typing the last content character | 16 | inside |
| ArrowRight from inside the word | 16 | inside |
| clicking the space after the word | 18 | outside |
| ArrowRight once more, from 16 | 18 | outside |

`skipAtomicRanges` only moves a caret that is **strictly** inside a marker, so
arrow motion and the mapped position after an insertion both stop at the inner
edge; a click resolves the tie toward `to` and lands outside. The offset
therefore already carries the user's intent, and the mode's job is to not throw
it away.

It used to throw it away. An `inputHandler` redirected every insertion at 18
back to 16, which is where "click in the space after a bold word, type, get
bold" came from — the single most reported thing about this mode. Continuation
is now **opt-in**: the default is to insert where the caret is, and a
Cmd+B-family key at the boundary arms `armedBoundaryField` so the next character
joins the span instead. Escape disarms, and the caret affordance
(`cm-continuation-active`) now means something the user chose rather than a
default they never saw.

Two things follow that are easy to get wrong:

- **The arrow keys are still not an exit.** At this boundary an arrow press
  moves the caret two offsets and zero pixels, which reads as a dead key; at end
  of line there is nowhere for it to go at all. Nothing about flipping the
  default changes that.
- **The opening edge is deliberately not symmetric.** A click just before a bold
  word lands at 10 — *inside* the content — because the glyph under the pointer
  is the first content character, and typing there produces bold. That is the
  same rule ("format comes from the character you clicked on"), not an
  oversight: at the closing edge the glyph under the pointer is the space, which
  is outside. Measured, not assumed.

Cmd+B at the boundary is also what stops the key from being destructive there.
Letting the normal toggle run would resolve the enclosing node and **unwrap**
the span the user was trying to extend.

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
live-preview. `keybindings.ts:70` is the gate; `continuationFormatArmSpec`
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

That mapping now runs in both directions. `visibleRangeForSource` is the
inverse, and it exists because the in-document anchor highlight lands on a table
data line, which is zero-height — the `Decoration.mark` is there, it is simply
painted onto nothing (#62). So `tables.ts` asks `ai-comment.ts` which fragments
are commented, maps them back to rendered offsets through the same token split,
and draws the highlight inside the cell with the same class the document
decoration uses. Two consequences worth knowing:

- The anchors are part of `TableWidget`'s `eq()`. They are structural here: they
  decide what the DOM contains, and without them CM6 reuses the widget and a new
  comment leaves no mark until something else rebuilds the table.
- `livePreviewPlugin` rebuilds when the comment field changes, for the same
  reason it rebuilds on `toggleTableMode`.

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

### A third target: the cell edit overlay

`currentTarget` resolves three surfaces, and the order is load-bearing. A cell
edit overlay outranks everything: while it is open it holds both the focus and
the authoritative text, and the document selection under it is stale.

What makes it different from the other two is that its text **is not in the
document**. So the format buttons cannot dispatch anything — they call
`toggleInlineFormatInText`, which builds a throwaway `EditorState` from the
overlay's text (`markdownExtension`, shared with `../setup.ts`) and runs the
same `formatSpec` the document path runs. The alternative, wrapping strings
over `ta.value`, is a second "bold"; see `../preview/CLAUDE.md` for why that
diverges on the first nested case.

One trap inside that: a freshly created `EditorState` has only whatever the
initial budgeted parse produced, and reading `syntaxTree` on an unparsed state
answers `Tree.empty`. Every toggle would then take the "add" path — bold could
be switched on and never off. Use `ensureSyntaxTree`.

The toolbar deliberately stays **open** after a format is applied here, unlike
the widget path where the change rebuilds the row and takes the DOM selection
with it. Nothing is rebuilt, the same words are still selected, and the next
click should be able to put italic on top of the bold just applied.

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

`</>` has no binding at all and gets a tooltip carrying just the action name —
it is the least legible thing in the row, and the tooltip is the only place
that ever says what it is.

💬 looked like the same case and was not: its key is real, and is declared in
the **native menu, in Rust** (`src-tauri/src/menu.rs`, item `ai_comment` →
`CmdOrCtrl+Shift+M`). Actions whose keys come from there never enter
`INLINE_FORMAT_BINDINGS`, so the caption honestly rendered without a key while
the key worked (#59). There are two notations and two declaration sites, and
they had already drifted.

`../native-menu-accelerators.ts` mirrors the Rust, and
`native-menu-accelerators.test.ts` parses `menu.rs` and asserts set equality —
it fails on an accelerator added in Rust and not mirrored, on a stale entry,
and on a changed key. The mirror is the cheap half; the test is the half that
makes it stay true. Both notations collapse to a `Shortcut { label, aria }`
before a button sees them, so one row cannot print its keys two ways.

Today `ai_comment` is the only native menu item with a UI affordance — the
others with accelerators (`new`, `open`, `save`, `save_as`, `close`,
`reopen_session`, `select_all`, `find`, `format_json`, `toggle_mode`, the three
zoom items) are menu-only. They are mirrored anyway, so the next button that
needs one already has it.

### A plain click on a link places the caret; ⌘/Ctrl-click opens it

`setup.ts`'s `mousedown` handler used to open the URL on **any** left click,
with `preventDefault` + `stopPropagation` before CM6 saw the event. The caret
could therefore not be put into a link's text with the mouse in *any* engine —
`#32`'s "нельзя поправить текст" included that, and it was the one place in the
document where "click a word to fix a typo" silently did nothing.

This is gated on `event.metaKey || event.ctrlKey` now, and the change is
deliberately **engine-wide**. A split where one engine opens on click and the
other places a caret would make the same gesture mean two things in the same
app. It is safe in live-preview for a specific reason: that mode reveals
`[text](url)` under the caret, so a plain click shows the user exactly what they
clicked into.

The gesture is only discoverable if something says so, so `decorateLink` puts it
in a `title` on the rendered link. That tooltip is the only place the app ever
mentions it.

Note the button test above it: on macOS Ctrl-click *is* a right click, which
`event.button !== 0` has already rejected, so accepting `ctrlKey` costs nothing
there and is what makes the gesture work on Windows and Linux.

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
- **A click just before a span types inside it.** Landing at the content's start
  is what the browser answers for a pointer over the first content character, and
  the format then comes from that character. The closing edge behaves the other
  way for the same reason — see the two-offsets-one-pixel section. Consistent,
  but it is a real asymmetry and someone will report it.
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
  `hiddenMarkRanges`, `repairChange`, `visibleDeleteRange`. Keep that split when
  adding behaviour.
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
