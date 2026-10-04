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

### 3. Document codec at the disk boundary

`src/lib/csv/csv-codec.ts` plus a small change in `readDocument` /
`writeDocument` (`src/lib/tauri/commands.ts`), the one pair every buffer load
and save already goes through (open, tab switch, session restore,
external-change reload, agent background edit).

- `isCsvPath(path)` — extension `csv` or `tsv`.
- The codec keeps per-path state in a module-level
  `Map<path, CsvDialect | 'raw'>`. `isCsvDocument(path)` is true only when the
  entry is a dialect, or there is no entry yet (a new file).
- **Read** of a CSV path: `parseCsv` → `rowsToTable`. The buffer gets the
  table; the dialect is stored. Parse failure → the read returns the raw text
  and the entry becomes `'raw'` (see Error handling). A later successful parse
  (external change fixed the file) flips it back.
- **Write** of a CSV path in `'raw'` state: the buffer is written as is, like
  any text file. Otherwise `tableToRows(buffer)` → `serializeCsv(rows,
  dialect)`; the dialect comes from the map, else the default for the extension
  (`,` / `\t`, no BOM, LF). CSV owns its own line endings — `applyLineEnding`
  is not applied on top. A buffer that is not exactly one table throws, which
  surfaces through the existing `save-error` toast and keeps the document
  dirty.
- **Baseline.** External-change detection compares disk text (after decode)
  with `diskBaseline` by string equality. A user edit leaves the buffer
  non-canonical (a commit does not re-pad the table), so the echo of our own
  save would decode to something ≠ buffer and be taken for an external change.
  For CSV paths `doSave` therefore stores `diskBaseline = decode(encode(buffer))`
  — exactly what the next read of that file returns. Exposed as
  `codecRoundTrip(path, text)`, identity for non-CSV paths.

### 4. CSV document kind

- `previewKindFor` (`file-language.ts`) gains `'csv'` for `isCsvPath`, and
  `setActiveDocument` downgrades it to `'code'` when
  `!isCsvDocument(path)` (the file did not parse).
- `applyDocumentConfig`: `'csv'` → markdown language, `setCodeMode(null)`, plus
  an editor class `cm-csv-file-mode`.
- `applyPreviewConfig`: `'csv'` always installs
  `[livePreviewPlugin, flavourFacet.of(LIVE_PREVIEW), tableConfig.of(CSV_TABLE_CONFIG), csvEditGuard]`
  **regardless of the engine** — Cmd+E (`raw`) and the live-render engine are
  global settings, so a CSV tab ignores them rather than trying to block the
  menu.
- `cm-csv-file-mode` hides the hover "+" gutter (CSS, the way
  `cm-code-file-mode` already restyles it).

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

- Undo/redo pass through (`tr.isUserEvent('undo' | 'redo')`), as do
  transactions without `docChanged`.
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
| CSV does not parse (unterminated quote) | Opens as plain text, as `.csv` does today, with a toast "Could not read as a table: …". This tab is not CSV kind: no codec on write — what is on screen is what is saved. |
| Save of a buffer that is not one table | Cannot happen through the UI (guard). If it does: `writeDocument` throws → existing `save-error` toast, document stays dirty, nothing written. |
| Save As a markdown note to `.csv` | Same as above if the note is not a single table; a note that is one table is exported as CSV. |
| Save As a CSV to `.md` | Writes the markdown table — an export. |

## Out of scope

- Row virtualization / rendering only the viewport.
- Comments and AI `show` precision on CSV (they work in buffer coordinates).
- Recovery restore (not wired for any file type today; snapshots of a CSV hold
  the markdown buffer, harmless).
- Choosing a header-less mode, changing the delimiter from the UI.

## Testing

- **Vitest, `csv.ts`:** quotes, `""`, embedded delimiter/newline, CRLF vs LF,
  BOM, `,`/`;`/Tab sniffing, unterminated quote, empty file, trailing newline
  kept/absent, `serializeCsv(parseCsv(x)) === x` for canonical inputs.
- **Vitest, `csv-table.ts`:** ragged rows, all-empty rows (kept as a table row by Lezer),
  pipes/newlines in cells, canonical idempotence, rejection of non-table text.
- **Vitest, codec:** `codecRoundTrip` makes an own-save echo resolve to
  `ignore` in `resolveExternalChange`.
- **Vitest, guard:** typing outside the table rejected; cell edit, add/delete
  row and column, undo, an emptied row pass.
- **Vitest, tables:** default `tableConfig` keeps the 500 cap and `-`
  placeholder (no regression in markdown).
- **Browser (`npm run dev`):** CSV injected through the codec — table renders,
  edits, add row shows no `-`.
- **`dev:app` + MCP bridge:** open a real `;`-delimited CRLF+BOM file, edit a
  cell, add a row, diff the bytes on disk; confirm no reload flicker after
  autosave; re-measure commit latency at 2k / 10k rows in WKWebView.
