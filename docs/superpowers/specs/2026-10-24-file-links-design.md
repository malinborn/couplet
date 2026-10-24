# File links — design

## Goal

A link to another file works: ⌘-click on `[план](2026-09-30-github-allowlist.md)` opens that file
as a tab (or switches to the tab / window that already holds it). And a human can put such a link
in as easily as an agent does — without typing a path.

Today neither half exists. ⌘-click and the inspector's «Open» hand every URL to
`plugin-shell open()`, whose default scope accepts only `http(s)`/`mailto`/`tel`; a file path is
refused and falls back to `window.open` inside the WKWebView, which does nothing visible. Nothing
resolves a path relative to the document. There is no file picker in the editor.

## Scope decisions (agreed with Max, 2026-09-30 / 2026-10-24)

1. **Storage format is plain markdown**: `[label](relative/path.md)`. Readable by GitHub, agents
   and every other editor; couplet is not the source of truth. No `[[wiki]]` syntax is ever
   written to the file.
2. **Ways in for a human** (option D + `/link`):
   - `[[` opens a file picker inline; choosing an item replaces `[[…]]` with a markdown link.
   - `/link` in the slash menu opens the same picker.
   - Drag a tab card / stash card / Finder file onto the text to insert a link to it.
3. **Picker scope** (option D): open tabs of every window → markdown files of the current
   project → recent files and the stash → «Choose file…» (system dialog).
4. Max: «ебаешь его до талого» — the whole feature, not a slice.

## Decisions made while designing (not separately asked)

### D1. What a link resolves to

One pure function, `resolveLinkTarget(url, docPath, home)`:

| URL | Result |
|---|---|
| `#slug` | `anchor` → `navigateToHeading` (unchanged) |
| has a scheme (`https:`, `mailto:`, …), except `file:` | `external` → shell `open` (unchanged scope) |
| `file:///abs/path` | `file` |
| `/abs/path` | `file` |
| `~/path` | `file`, `~` → home (agents write these) |
| anything else | `file`, relative to the **document's directory** |

- `<…>` around the destination is stripped; the path is percent-decoded (`%20` → space).
- A `#fragment` after a file path is kept: `plan.md#risks` opens `plan.md`, then jumps to the
  heading `risks` with the existing slug rules.
- A relative path in a document with no path (a blank untitled tab) is `unresolvable` → toast.

### D2. What opening a file does

- **Couplet opens it as a document** if it is a regular file (not a folder) whose kind couplet
  already renders: markdown/txt (`isMarkdownBuffer`), csv/tsv, env, shell, or a code language
  `findCodeLanguage` knows. → `openTab(path)`, i.e. the existing `decideOpenAction`: already
  active → nothing; held by another window → that window comes forward; background tab here →
  activated; otherwise a new tab after the active one. Then the fragment, if any, if the file is
  now this window's active tab (a file shown in another window loses the fragment — documented).
- **Anything else** (images, PDFs, folders, `.app`, `.command`, binaries) → **Reveal in Finder**,
  never opened. A markdown file is untrusted input; ⌘-click on `[notes](run.command)` must not
  execute anything. New Rust command `reveal_in_finder(path)` (`NSWorkspace
  activateFileViewerSelectingURLs:` through the `objc` runtime, like `keep_behind_key_window`;
  no new crate, no shell scope widening).
- **Missing file** → toast `link-missing` «No file *name*» with action «Create». «Create» calls
  `openTab(path)`, which already opens a missing path as a new unsaved file — saved where the link
  points. Never created silently on click: a typo in an agent's link must not litter the disk.

### D3. Gestures

Unchanged gestures, one router. ⌘-click on a link (both modes), the inspector's «Open» (live
render) and a plain click on a link in a table cell all call `openLink(view, url)`, which consults
a `LinkControl` dep (like `stashControl`). Without the dep (the landing's demo editors) the old
external-only behaviour stays. The inspector's button label/aria follow the target: «Open» /
«Open file» / «Show in Finder» / «Jump to heading».

### D4. How a link looks

- Hover title says where it goes: «⌘-click to open *name*», or «⌘-click to show in Finder».
- **A file link whose target does not exist** gets `cm-md-link-missing` (dashed underline,
  muted) and the title «File not found — ⌘-click to create». Existence is asked asynchronously:
  a `linkExistence` StateField (resolved path → `true`/`false`), filled by a ViewPlugin that
  batches `file_exists` for links in the viewport (trailing 150 ms) and dispatches one effect.
  The cache drops on document-path change and on window focus (a file created elsewhere).
  Unknown = rendered as an ordinary link; never flicker to "missing" before an answer.

### D5. The picker

One completion source, `fileLinkSource`, behind two triggers:

- **`[[`** anywhere in a line (not inside code / an existing link). `closeBrackets` turns `[[`
  into `[[|]]`; the source matches `[[query` before the caret and the result's `to` swallows a
  trailing `]]`. `Esc` leaves `[[query]]` as typed text.
- **`/link`** (slash action, line start like every slash command) inserts `[[]]` with the caret
  inside and calls `startCompletion` — the same source, no second picker machinery.

**Candidates** come from one Rust command, `link_candidates({ docPath })`, fetched when the
picker opens and cached for the life of that popup (the source returns a `Promise` the first time,
then filters the snapshot synchronously). Each candidate: `{ path, group, title? , window? }`.
Groups, in display order:

1. **Tabs** — every tab with a path in every window (the registry; `window` = `#N` for other
   windows). The current document is excluded.
2. **Project** — markdown-ish files (`md`, `markdown`, `txt`, `csv`, `tsv`) under the window's
   project root (`window_project().root`; git toplevel, or the document's folder outside git).
   Walk: std only (no new crate), skips dot-directories and `node_modules`, `target`, `dist`,
   `build`, `vendor`, `__pycache__`, `venv`; depth ≤ 10, ≤ 5 000 files, ≤ 300 ms; symlinked
   directories not followed. Cached per root for 30 s. Truncation is reported (`truncated: true`)
   and shown as a muted last line «Not all project files listed».
3. **Recent** — `recent_files_list`.
4. **Stash** — notes and file references; a note's label is its title.
5. **«Choose file…»** — always last, always visible; opens the system open dialog
   (`FILE_FILTERS`), and its result is inserted like any candidate.

A path appears once, in its highest group. **Filtering is ours** (`filter: false`): a
case-insensitive subsequence match over the label and the project-relative path, ranked by
group, then by match quality (prefix of the name > word start > subsequence), then by recency.
Empty query → each group's natural order, at most 8 per group, «Choose file…» last.
If the query looks like a URL (`https?://…`), the first option is «Link to *url*» → `[url](url)`.

The source object is built once (stable identity — see the CLAUDE.md gotcha) and gets the
current `LinkControl` through the dep, not a closure re-created per lookup.

### D6. What gets inserted

`[label](destination)`:

- **label** — a stash note's title; a markdown file's name without `.md`/`.markdown`; any other
  file's full name. No selection case exists: both triggers start from a collapsed caret.
- **destination** — relative to the document's folder when the document has a path **and** the
  target is inside the same project root (or the same folder tree when outside git); otherwise
  absolute. `./` is never written; `../` is. A destination containing spaces, `(`, `)` or `<`
  is written as `<…>` (CommonMark), never percent-encoded — it stays readable.

### D7. Drag to insert a link

- **Stash card** dropped on the editor text (today: does nothing) → link at the drop point. CM6
  `posAtCoords` from the pointer.
- **Tab card**: a plain drag over the page still means "move to a window" (carousel). Holding
  **⌥** during the drag switches to link mode: the carousel closes (or never opens), the page
  shows a drop caret at `posAtCoords`, and the drop inserts a link. ⌥ is macOS's "copy, don't
  move" modifier. The carousel band shows the hint «⌥ — insert a link instead». Releasing ⌥
  returns to move mode.
- **Finder file**: a plain drop still opens it as a tab. **⌥-drop** inserts a link at the drop
  position instead. The webview gets no key events while Finder drives the drag, so Rust answers
  the modifier state at drop time: `current_modifiers()` reads `NSEvent.modifierFlags` (class
  method, global state). Tauri's drop event carries the position (physical px → logical →
  `posAtCoords`). Several files → one link per file, separated by `, `.
- The drop caret is CM6's `dropCursor()`-style marker drawn by our own small plugin (the theme
  already styles `.cm-dropCursor`), shown only during a link-mode drag.

### D8. Agents

`docs/ai-interface.md`'s pasteable agent snippet gains one line: refer to other files with
relative markdown links (`[name](path.md)`), which couplet opens on ⌘-click. No protocol change.

### D9. Strings

Every new UI string goes through `t()` with keys in all six `locales/*/app.json` (en is the
fallback; ru written by hand, the rest translated). The existing English-only link hint in
`inline.ts` moves to `t()` too while we are there.

## Out of scope

- Rename tracking / backlinks / a link graph.
- `[[` resolving by name at render time (we never store `[[…]]`).
- ⌘K "insert link" (the inspector already edits a URL; the picker is reachable by `[[`).
- ⌘⇧-click → new window.
- Images (`![](…)`) — the preview renders none.

## Architecture

New / changed units (each testable alone):

| Unit | Kind | Responsibility |
|---|---|---|
| `src/lib/links/link-target.ts` | pure | `resolveLinkTarget`, `splitFragment`, decoding, `<…>` |
| `src/lib/links/link-destination.ts` | pure | `destinationFor(target, docPath, projectRoot)`, `labelFor(candidate)`, `<…>` encoding |
| `src/lib/links/link-kind.ts` | pure | `opensAsDocument(path)` from `file-language.ts` + `isCsvPath` |
| `src/lib/links/link-filter.ts` | pure | dedup-by-group, scoring, per-group caps, URL option |
| `src/lib/links/ipc.ts` | IPC | `linkCandidates`, `revealInFinder`, `currentModifiers` |
| `src/lib/editor/links/open-link.ts` | CM6 | `openLink(view, url)` router + `LinkControl` facet/dep |
| `src/lib/editor/links/link-existence.ts` | CM6 | StateField + batching ViewPlugin + `cm-md-link-missing` |
| `src/lib/editor/links/file-link-source.ts` | CM6 | the `[[` completion source (stable), apply → insert |
| `src/lib/editor/links/slash-link.ts` | CM6 | `/link` slash action |
| `src/lib/editor/links/link-drop.ts` | CM6 | drop caret + `insertLinkAt(view, pos, candidates)` |
| `src-tauri/src/links.rs` | Rust | `link_candidates` (registry + walk + recent + stash), walk cache |
| `src-tauri/src/reveal.rs` | Rust | `reveal_in_finder`, `current_modifiers` (objc runtime) |
| App.svelte | wiring | builds `LinkControl` (openTab, fragment jump, toasts, dialog) |
| TabDrawer / drop-target | change | ⌥ link mode, stash-card drop on page |
| ToastStack | change | `link-missing` kind with «Create» |

`LinkControl`:

```ts
interface LinkControl {
  docPath(): string | null;            // documentPathField already exists
  projectRoot(): Promise<string | null>;
  openFile(path: string, fragment: string | null): Promise<void>;
  reveal(path: string): Promise<void>;
  missing(path: string): void;         // toast with «Create»
  candidates(): Promise<LinkCandidates>;
  chooseFile(): Promise<string | null>;
}
```

## Error handling

- `link_candidates` failing → picker shows only «Choose file…» (and the URL option); logged.
- A project walk hitting a limit → partial list + `truncated`; never blocks the popup > 300 ms.
- `file_exists` failing → unknown (ordinary link style), retried on next viewport change.
- `reveal_in_finder` failing → `open-error` toast with the path.
- `current_modifiers` failing → treated as no modifier (plain drop opens, as today).

## Testing

- Vitest, pure: `link-target` (every row of D1, encodings, fragments, untitled), `link-destination`
  (relative/absolute rules, `../`, `<…>`), `link-kind`, `link-filter` (groups, dedup, ranking,
  caps, URL option, empty query).
- Vitest, CM6: `[[` source on `EditorState` (match with/without auto-closed `]]`, not in code,
  apply replaces `[[q]]`), **identity test** (two `languageDataAt('autocomplete')` calls return
  the same function), `/link` inserts `[[]]` and starts completion, `openLink` routing with a fake
  `LinkControl`, existence field/decoration with a fake checker, drop insertion.
- Cargo: walker (skips, depth/file/time limits, symlinks not followed, truncation), candidate
  merge/dedup/order, `current_modifiers` mapping of flag bits.
- Live, `npm run dev:app -- --features mcp-bridge`: ⌘-click to a tab in this window, in another
  window, a missing file (toast → Create), a `.png` (Finder), `plan.md#heading`; `[[` and `/link`
  picker with real candidates; ⌥-drag of a tab card; stash-card drop; ⌥-drop from Finder (manual
  by Max — no OS-level drags from an agent).
