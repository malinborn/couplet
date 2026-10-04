# CSV files as tables

## Goal

Open a `.csv` / `.tsv` file and get the same table the editor already draws for
a GFM table in markdown — cell editing, Tab/Enter navigation, ± rows and
columns, drag, wrap/full — and have every save write valid CSV back to the same
file, in the file's own dialect.

## Principle: CSV extends the table, it does not fork it

The buffer of a CSV document **is a GFM markdown table**. CSV exists only at
the disk boundary: decoded on read, encoded on write. Everything that already
works on markdown tables works on CSV unchanged, because it never sees CSV.

Changes to existing table code are limited to two configuration hooks (row cap,
empty-row placeholder), both defaulting to today's behaviour. No branch on
"is this CSV" inside `tables.ts`.

Rejected alternatives:

- **CSV text in the buffer + a CSV decorator.** Every table operation
  (`replaceTable`, `addRow`, cell commit, the `from`/`to` positions it all
  relies on) would have to learn a second source format.
- **A separate grid component outside CM6.** Re-implements the whole table UX,
  undo, search and autosave integration.

## Scope decisions (agreed)

| Question | Decision |
|---|---|
| View or edit? | Edit, and autosave writes CSV back to the same file. |
| Content outside the table | Not allowed: the window holds exactly one table. Edits that would break that are rejected. |
| Header | The first CSV record is always the header row. |
| Size cap | None for CSV. Markdown tables keep their 500-line cap. |
| Extensions | `.csv` (delimiter sniffed), `.tsv` (always Tab). |

Measured cost, Chrome, 6 columns, markdown table below the cap: open 23–36 ms
up to 500 rows; a cell commit ~0.1 ms per row (full widget rebuild) — 50–64 ms
at 498 rows, so ~200 ms at 2k rows, ~1 s at 10k. Typing inside a cell goes to
the overlay `<textarea>` and costs nothing; only the commit pays. Accepted for
CSV without a cap. To be re-measured in WKWebView (`dev:app`) during
implementation.

Re-measured 2026-10-04 in WKWebView (`dev:app`, debug build + Vite dev
server, window occluded by a locked screen), 6 columns. A cell commit costs
`view.update` (decoration rebuild + DOM of the whole widget) **plus the first
layout of the rebuilt widget**, which the Chrome estimate above did not
count:

| Rows | `view.update` per edit | first layout after it | cell commit total | open (command → editor configured) |
|---|---|---|---|---|
| 2 000 | ~0.42 s | ~0.8 s | 1.2–1.4 s | ~0.5 s sync work; agent `open` answered in 1.7 s |
| 10 000 | ~2.3–2.4 s | ~6.7 s | ~11 s | ~2.1 s sync work + layout; agent `open` timed out (8 s) |

So a 10k-row CSV is not practically editable without row virtualization
(out of scope below); 2k is usable but sluggish.

## Units

### 1. `src/lib/csv/csv.ts` — CSV parse / serialize (pure, no deps)

```ts
type CsvDialect = {
  delimiter: ',' | ';' | '\t'; bom: boolean; eol: '\n' | '\r\n' | '\r';
  trailingNewline: boolean; trailingBlankLines: number;
};
parseCsv(text: string, hint?: { delimiter?: CsvDialect['delimiter'] }):
  { ok: true; rows: string[][]; dialect: CsvDialect } | { ok: false; error: string }
serializeCsv(rows: string[][], dialect: CsvDialect): string
```

- RFC 4180: quoted fields, `""` inside quotes, delimiters and newlines inside
  quotes. An unterminated quote is `ok: false`.
- Delimiter sniffing for `.csv`: among `,` `;` `\t`, the one that gives the
  most consistent non-trivial field count over the first ~20 records (quotes
  respected); ties → `,`. `.tsv` passes `hint.delimiter = '\t'`.
- `bom`: leading U+FEFF is stripped on parse and restored on serialize.
- `eol`: the first record separator outside quotes (LF, CRLF or CR).
  Newlines inside quoted fields are kept as they were read.
- `trailingBlankLines`: empty lines after the last record are not rows; their
  count is kept and written back, so an edit does not turn them into `,` lines.
  Empty lines in the middle stay as (all-empty) rows.
- Serialize quotes a field only if it contains the delimiter, `"`, `\r` or
  `\n`. The trailing newline of the file is kept iff the input had one.
- A file with no records (empty file) is valid: zero rows.

### 2. `src/lib/csv/csv-table.ts` — rows ↔ GFM table text

```ts
rowsToTable(rows: string[][]): string        // canonical GFM text
tableToRows(md: string): { ok: true; rows: string[][] } | { ok: false; error: string }
```

- Header = first row. Ragged rows are padded with empty cells to the widest
  row. An empty file becomes a one-column table with an empty header (so a new
  `.csv` opens as an editable table).
- Cell text is encoded with the same rules as `encodeForCommit` (newline →
  `<br>`, `|` → `\|`) but without its trailing-newline strip, which would lose
  data for a value like `"a\n"`; it is decoded with `decodeForEdit`. Known,
  tested limitation: a literal `<br>` in a CSV value comes back as a newline;
  the exact behaviour for a literal `\|` is pinned by a test.
- **No empty-row mark.** The project notes claimed Lezer GFM drops a
  whitespace-only row from the `Table` node. Measured 2026-10-04
  (`@lezer/markdown` 1.6.3, Lezer and the rendered widget): an all-empty row is
  kept and drawn — in the middle, at the end with and without a trailing
  newline, and as an empty header. So empty CSV rows are written as plain empty
  cells; nothing invisible ever enters the buffer.
- Cells are read back with the table code's own `parseCellsWithPositions`, so
  the codec sees exactly the cells the widget shows. That function trims cells,
  hence a known limitation: leading/trailing spaces of a CSV value
  (`a, b, c`) are not preserved once the file is saved. Changing that would mean
  changing cell parsing for markdown tables, which this feature does not do.
- CRLF inside a quoted field comes back as LF.
- Output is canonical (same padding as `replaceTable`'s
  `markdownTable(…, { align: null, padding: true })`), so
  `rowsToTable(tableToRows(rowsToTable(r))) === rowsToTable(r)`.
- `tableToRows` fails if the text is anything other than one table optionally
  followed by blank lines — strictly what Lezer and the widget draw as one
  table: every line starts with `|` and ends with an unescaped `|`, the
  delimiter row has as many cells as the header, and no row is wider than the
  header (GFM would drop the extra cells, a silent loss on save).

### 3. Document codec at the disk boundary — stateless

`src/lib/csv/csv-codec.ts` plus a small change in `readDocument` /
`writeDocument` (`src/lib/tauri/commands.ts`), the one pair every buffer load
and save already goes through (open, tab switch, session restore,
external-change reload, agent background edit).

**No state.** An earlier draft kept a per-path `Map<path, dialect | 'raw'>`.
Review found it corrupts files: every read rewrote the entry — a drawer
preview or an agent read of a file broken by another program flipped it to
`'raw'`, and the next autosave wrote the markdown buffer into the `.csv`;
the same file opened under two spellings (`/tmp` vs `/private/tmp`, a
symlink) kept its dialect under one key and was written under the other, so
`;` + BOM + CRLF silently became `,` + LF. So nothing is remembered:

- `isCsvPath(path)` — extension `csv` or `tsv`.
- **What to write is decided by the buffer.** A CSV path whose buffer is
  exactly one table (`tableToRows(buffer).ok`) is encoded as CSV; any other
  buffer — the plain text of a CSV that failed to parse — is written as is,
  like any text file. The two cannot be confused in practice: CSV text that
  parses as a GFM table would have to start every line with `|`.
- **The dialect is read from the file being replaced, at write time.**
  `writeDocument` reads the current file at the same path it is about to
  write and takes its dialect with `sniffDialect(raw)` (delimiter, BOM, record
  separator, trailing newline/blank lines — never fails, also on a file that
  no longer parses). Any other read error (iCloud placeholder, a file being
  replaced, EACCES) fails the save — the `save-error` toast, retried on the
  next save — instead of silently dropping the BOM. No file there → the
  extension's default (`,` / `\t`, no
  BOM, LF). The read and the write use one path, so path spelling cannot
  split them. Cost: one extra read per CSV save.
- **Read** of a CSV path: `parseCsv` → `rowsToTable`; parse failure → the raw
  text, as any file.
- **A CSV path that does not exist yet** opens as `rowsToTable([])` (an empty
  one-column table), so a new `.csv` is editable as a table and saves as an
  empty file until something is typed.
- CSV owns its own line endings — `applyLineEnding` is not applied on top.
- **Baseline.** External-change detection compares disk text (after decode)
  with `diskBaseline` by string equality, and a cell commit leaves the buffer
  non-canonical. When it CSV-encoded a table, `writeDocument` therefore
  returns what the next read of the file will return —
  `decodeFromDisk(path, writtenBytes)`, computed from the real bytes so it
  cannot drift from the decoder — and `doSave` stores that as the baseline.
  When it wrote the buffer as is (non-CSV paths, and plain text on a CSV path)
  it returns the buffer. Almost any text parses as CSV, so for plain text the
  decoded table would leave buffer ≠ baseline for good (every later external
  change a conflict); with the buffer as baseline the own-save echo takes the
  ordinary `reload` path and the tab becomes a table.
- `serializeCsv` quotes, in a one-column table, every value containing any of
  `,` `;` Tab: with a single column the re-read sniffs the delimiter again,
  and an unquoted `Moscow, RU` would come back as two columns.

### 4. CSV document kind

- `previewKindFor` (`file-language.ts`) gains `'csv'` for `isCsvPath`.
- The kind a document actually gets is `documentPreviewKind(path, text)`:
  `'csv'` only when its buffer is one table, otherwise `'code'` (a CSV that did
  not parse is shown as plain text). It is derived from the buffer, so it is
  recomputed whenever the buffer is replaced from disk — including an
  external-change reload, which can turn a table into plain text (the file was
  broken elsewhere) or back (it was fixed).
- `applyDocumentConfig`: `'csv'` → markdown language, `setCodeMode(null)`, plus
  an editor class `cm-csv-file-mode`.
- `applyPreviewConfig`: `'csv'` always installs
  `[livePreviewPlugin, flavourFacet.of(LIVE_PREVIEW), tableConfig.of({ maxLines: Infinity, placeholder: '' }), csvEditGuard]`
  **regardless of the engine** — Cmd+E (`raw`) and the live-render engine are
  global settings, so a CSV tab ignores them rather than trying to block the
  menu.
- `cm-csv-file-mode` hides the hover "+" gutter (CSS, the way
  `cm-code-file-mode` already restyles it).
- `cm-csv-file-mode` also hides the per-table ⇔ wrap/full toggle: it would
  expose the markdown source, which the file does not contain and where the
  one-table guard drops edits.

### 5. `tableConfig` facet — the two hooks in table code

```ts
type TableConfig = { maxLines: number; placeholder: string };
// default { maxLines: 500, placeholder: '-' }  — today's behaviour
// CSV     { maxLines: Infinity, placeholder: '' }
```

- `buildTableContext(doc, from, to, maxLines = 500)`; `decorateTable` and
  `tableContextAtLine` read the facet from state and pass it in.
- `addRow`, `newRowMarkdown` (`table-navigation.ts`, used by
  `Mod-Shift-Enter`) and `addColumn` take the placeholder from the facet: in a
  CSV a new row or column is empty, not `-` in the file.
- `livePreviewPlugin` rebuilds on a change of this facet, like `flavourFacet`.

### 6. `csvEditGuard` — the window holds exactly one table

A `transactionFilter` installed only for CSV:

- Transactions without `docChanged` pass.
- **Undo/redo are guarded at the command, not in the filter.** After an
  `addToHistory: false` reload CM6 maps the stored undo events through the
  replacement, and the inverse of an old deletion can land as an insertion at
  the edge of the replaced span: a non-table that autosave would write into the
  `.csv`. A filter cannot stop it — CM6 history dispatches undo/redo with
  `filter: false`. So the CSV bundle adds `csvUndo`/`csvRedo` at
  `Prec.highest` (the history keys, the selection-history keys, and
  `beforeinput` `historyUndo`/`historyRedo`, which is how the native Edit menu
  arrives): they run the history command into a capturing dispatch and apply
  the result only if it is still one table. An undo that crosses a disk reload
  and would break the table does nothing.
- A buffer replaced from disk passes too (`addToHistory: false`, the mark
  `human-edit.ts` already uses for a disk reload): the file is the truth, and
  if it no longer holds a table the document kind becomes `'code'` (§4).
- Otherwise: if `tableToRows(tr.newDoc)` fails, the transaction is dropped
  (`return []`). This covers typing outside the table, slash commands, hover
  inserts, pasted text, and a second table.

The check is O(document) per edit — same order as the widget rebuild already
paid on every commit.

### 7. Wiring outside the editor

- `tauri.conf.json` `fileAssociations`: add `csv`, `tsv`.
- Dialog filters (`commands.ts`): add `tsv` next to `csv`.
- **AI `edit` on a CSV path is refused** with a clear error ("couplet edit
  does not support CSV files yet") in both `liveEdit` and the background-tab
  path — otherwise an agent's CSV text would be diffed into a markdown buffer
  and saved as table rows. `show` stays best-effort (line numbers are buffer
  lines: header = 1, delimiter row = 2).

## Error handling

| Situation | Behaviour |
|---|---|
| CSV does not parse (unterminated quote) | Opens as plain text (kind `'code'`), as `.csv` does today. What is on screen is what is saved. Once the text parses again (fixed here or elsewhere), the next read shows it as a table. |
| File broken by another program while the table has unsaved edits | The usual conflict dialog. "Keep mine" writes the table as CSV in the dialect sniffed from the broken file. |
| Save of a CSV buffer that is not one table | Written as is (that is what a plain-text CSV tab is). The guard keeps a table tab from getting there. |
| Save As a markdown note to `.csv` | A note that is one table is exported as CSV; any other note is written as is. |
| Save As a CSV to `.md` | Writes the markdown table — an export. |
| Save As a CSV to a new `.csv` | The default dialect (there is no file to sniff); over an existing `.csv`, that file's dialect. |

## Known limitations (accepted)

- Leading/trailing spaces of a CSV value are trimmed once the file is saved;
  a literal `<br>` in a value comes back as a newline; CRLF inside a quoted
  field comes back as LF; a U+FEFF/BOM is kept, a file containing exactly `""`
  saves as empty.
- Cmd+Z across an external reload of a CSV tab does nothing (see §6).
- A keystroke landing in the few milliseconds between saving a plain-text CSV
  and its watcher echo shows the conflict dialog for the user's own save (the
  echo decodes to a table, the baseline is the plain text). Only on the
  plain text → table transition; fixing it means changing the shared
  external-change resolution.
- Enter on the last row leaves the table onto the empty line below it, where
  typing is dropped; Cmd+Shift+Enter adds a row.
- Every CSV save reads the current file once more (to sniff its dialect).

## Out of scope

- Row virtualization / rendering only the viewport.
- Comments and AI `show` precision on CSV (they work in buffer coordinates).
- Recovery restore (not wired for any file type today; snapshots of a CSV hold
  the markdown buffer, harmless).
- Drawer card previews read a CSV through the codec, i.e. parse and pad the
  whole file for a card. Fine for typical files; a size-capped peek is a later
  optimisation.
- Choosing a header-less mode, changing the delimiter from the UI.

## Testing

- **Vitest, `csv.ts`:** quotes, `""`, embedded delimiter/newline, CRLF vs LF,
  BOM, `,`/`;`/Tab sniffing, unterminated quote, empty file, trailing newline
  kept/absent, `serializeCsv(parseCsv(x)) === x` for canonical inputs.
- **Vitest, `csv-table.ts`:** ragged rows, all-empty rows (kept as a table row by Lezer),
  pipes/newlines in cells, canonical idempotence, rejection of non-table text.
- **Vitest, codec:** the baseline `writeDocument` returns makes an own-save
  echo resolve to `ignore` in `resolveExternalChange`; the dialect follows the
  file on disk (incl. a broken one and a never-existing one); a read never
  changes how a later write behaves (no state); a one-column value with `,`
  survives a save + re-read.
- **Vitest, guard:** typing outside the table rejected; cell edit, add/delete
  row and column, undo, an emptied row pass.
- **Vitest, tables:** default `tableConfig` keeps the 500 cap and `-`
  placeholder (no regression in markdown).
- **Browser (`npm run dev`):** CSV injected through the codec — table renders,
  edits, add row shows no `-`.
- **`dev:app` + MCP bridge:** open a real `;`-delimited CRLF+BOM file, edit a
  cell, add a row, diff the bytes on disk; confirm no reload flicker after
  autosave; re-measure commit latency at 2k / 10k rows in WKWebView.
