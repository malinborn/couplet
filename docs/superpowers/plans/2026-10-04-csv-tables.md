# CSV Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open `.csv` / `.tsv` files as the editor's existing GFM table widget, editable, with every save writing valid CSV back in the file's own dialect.

**Architecture:** The buffer of a CSV document is a GFM markdown table. CSV exists only at the disk boundary (`readDocument` / `writeDocument`): decoded on read, encoded on write. Table code gets two facet-driven hooks (row cap, empty-cell placeholder) defaulting to today's behaviour; everything CSV-specific lives in `src/lib/csv/`. A transaction filter keeps a CSV window to exactly one table.

**Tech Stack:** TypeScript, Svelte 5, CodeMirror 6, `@lezer/markdown` (GFM), `markdown-table`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-csv-tables-design.md` — read it first.

**Ground rules for every task**

- Work only in `/Users/maximkovalevskij/playground/md-mini/.claude/worktrees/csv-tables`.
- Never `git stash`, `git checkout <file>`, `git reset`, `git rebase`. `git add` explicit paths only.
- Run tests with `npx vitest run <path>` (plain `npm run test` also picks up other worktrees).
- Never run `npm run tauri dev` / `npm run tauri build`. Browser checks: `npm run dev`. Tauri checks: `npm run dev:app`.
- Do not change the behaviour of markdown tables. The only edits allowed in table code are the ones Task 3 lists.
- Conventional commits, ending with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/csv/csv.ts` | new | RFC 4180 parse/serialize, delimiter sniffing, dialect |
| `src/lib/csv/csv-table.ts` | new | rows ↔ canonical GFM table text, empty-cell mark |
| `src/lib/csv/csv-codec.ts` | new | per-path codec state, disk decode/encode, baseline round trip, preview kind |
| `src/lib/csv/csv-guard.ts` | new | transaction filter: the buffer stays one table; repairs emptied rows |
| `src/lib/csv/csv-extensions.ts` | new | the stable extension array a CSV tab installs |
| `src/lib/editor/preview/table-config.ts` | new | `tableConfig` facet (`maxLines`, `placeholder`) |
| `src/lib/editor/preview/tables.ts` | modify | read the facet: cap + placeholder (addRow, addColumn, Mod-Shift-Enter) |
| `src/lib/editor/preview/table-navigation.ts` | modify | `newRowMarkdown(colWidths, placeholder = '-')` |
| `src/lib/editor/preview/plugin.ts` | modify | rebuild when `tableConfig` changes |
| `src/lib/tauri/commands.ts` | modify | route read/write through the codec; `tsv` in dialog filters |
| `src/lib/editor/file-language.ts` | modify | `PreviewKind` gains `'csv'` |
| `src/App.svelte` | modify | kind, class, preview config, save baseline |
| `src/styles/editor.css` | modify | `cm-csv-file-mode` hides the hover gutter |
| `src/lib/tabs/agent-commands.ts` | modify | refuse `edit` on CSV paths |
| `src-tauri/tauri.conf.json` | modify | `csv`, `tsv` file associations |

---

### Task 1: CSV parse / serialize

**Files:**
- Create: `src/lib/csv/csv.ts`
- Test: `src/lib/csv/csv.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/csv/csv.test.ts
import { describe, it, expect } from 'vitest';
import { parseCsv, serializeCsv, type CsvDialect } from './csv';

function ok(text: string, hint?: Parameters<typeof parseCsv>[1]) {
  const r = parseCsv(text, hint);
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe('parseCsv', () => {
  it('parses plain records', () => {
    expect(ok('a,b\n1,2\n').rows).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('handles quoted fields with delimiter, quote and newline', () => {
    const r = ok('name,note\n"Doe, J","say ""hi""\nbye"\n');
    expect(r.rows).toEqual([['name', 'note'], ['Doe, J', 'say "hi"\nbye']]);
  });

  it('keeps empty fields and empty lines', () => {
    expect(ok('a,b\n,\n\nx,\n').rows).toEqual([['a', 'b'], ['', ''], [''], ['x', '']]);
  });

  it('fails on an unterminated quote', () => {
    const r = parseCsv('a,b\n"open,2\n');
    expect(r.ok).toBe(false);
  });

  it('parses an empty file as zero rows', () => {
    expect(ok('').rows).toEqual([]);
  });

  it('sniffs semicolon', () => {
    const r = ok('name;city\nIvan, Jr;Moscow\nAnna;Kazan\n');
    expect(r.dialect.delimiter).toBe(';');
    expect(r.rows[1]).toEqual(['Ivan, Jr', 'Moscow']);
  });

  it('sniffs tab', () => {
    expect(ok('a\tb\n1\t2\n').dialect.delimiter).toBe('\t');
  });

  it('defaults to comma for a single column', () => {
    expect(ok('a\nb\n').dialect.delimiter).toBe(',');
  });

  it('honours the delimiter hint', () => {
    expect(ok('a,b\tc\n', { delimiter: '\t' }).rows).toEqual([['a,b', 'c']]);
  });

  it('records BOM, CRLF and trailing newline', () => {
    const r = ok('﻿a,b\r\n1,2\r\n');
    expect(r.dialect).toEqual({ delimiter: ',', bom: true, eol: '\r\n', trailingNewline: true });
    expect(r.rows).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('records a missing trailing newline', () => {
    expect(ok('a,b\n1,2').dialect.trailingNewline).toBe(false);
  });
});

describe('serializeCsv', () => {
  const lf: CsvDialect = { delimiter: ',', bom: false, eol: '\n', trailingNewline: true };

  it('quotes only what needs quoting', () => {
    expect(serializeCsv([['a', 'b,c', 'say "hi"', 'x\ny', ' pad ']], lf)).toBe(
      'a,"b,c","say ""hi""","x\ny", pad \n'
    );
  });

  it('uses the dialect delimiter, eol, bom and trailing newline', () => {
    const d: CsvDialect = { delimiter: ';', bom: true, eol: '\r\n', trailingNewline: false };
    expect(serializeCsv([['a', 'b'], ['1', '2;3']], d)).toBe('﻿a;b\r\n1;"2;3"');
  });

  it('serializes zero rows as an empty file', () => {
    expect(serializeCsv([], lf)).toBe('');
  });

  it.each([
    'a,b\n1,2\n',
    'a;b\r\n"x;y";2\r\n',
    '﻿name,note\n"a ""q""","l1\nl2"\n',
    'a,b\n,\nx,\n',
    'a\tb\n1\t2',
  ])('round-trips canonical input %j', (text) => {
    const r = ok(text);
    expect(serializeCsv(r.rows, r.dialect)).toBe(text);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/csv/csv.test.ts`
Expected: FAIL — `Failed to resolve import "./csv"`.

- [ ] **Step 3: Implement**

```ts
// src/lib/csv/csv.ts
/**
 * RFC 4180 CSV, parsed to rows of strings and written back in the dialect it
 * was read in. Pure: no editor, no disk. The table side lives in
 * `csv-table.ts`, the disk side in `csv-codec.ts`.
 */

export type CsvDelimiter = ',' | ';' | '\t';

export interface CsvDialect {
  delimiter: CsvDelimiter;
  /** The file started with U+FEFF. */
  bom: boolean;
  /** Record separator, taken from the first line break in the file. */
  eol: '\n' | '\r\n';
  /** The file ended with a record separator. */
  trailingNewline: boolean;
}

export type CsvParse =
  | { ok: true; rows: string[][]; dialect: CsvDialect }
  | { ok: false; error: string };

const BOM = '﻿';
const CANDIDATES: readonly CsvDelimiter[] = [',', ';', '\t'];
const SNIFF_CHARS = 65536;
const SNIFF_ROWS = 20;

/**
 * Split `text` into records. `lenient` returns what was read when the text
 * ends inside quotes (used for sniffing a truncated sample); otherwise that
 * is an error and the answer is `null`.
 */
function parseWith(text: string, delimiter: string, lenient: boolean): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c;
    i++;
  }
  if (quoted && !lenient) return null;
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * The delimiter that splits the sample into the most consistent multi-column
 * records: the header's field count, times how many of the first records share
 * it. A strict `>` keeps `,` on a tie.
 */
function sniffDelimiter(text: string): CsvDelimiter {
  const sample = text.slice(0, SNIFF_CHARS);
  let best: CsvDelimiter = ',';
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const rows = (parseWith(sample, d, true) ?? []).slice(0, SNIFF_ROWS);
    if (rows.length === 0) continue;
    const width = rows[0].length;
    if (width < 2) continue;
    const score = width * rows.filter((r) => r.length === width).length;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

export function parseCsv(text: string, hint?: { delimiter?: CsvDelimiter }): CsvParse {
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(1) : text;
  const delimiter = hint?.delimiter ?? sniffDelimiter(body);
  const rows = parseWith(body, delimiter, false);
  if (rows === null) return { ok: false, error: 'unterminated quoted field' };
  const lf = body.indexOf('\n');
  const eol = lf > 0 && body[lf - 1] === '\r' ? '\r\n' : '\n';
  const trailingNewline = body.endsWith('\n') || body.endsWith('\r');
  return { ok: true, rows, dialect: { delimiter, bom, eol, trailingNewline } };
}

function quoteField(field: string, delimiter: string): string {
  const needs =
    field.includes(delimiter) || field.includes('"') || field.includes('\n') || field.includes('\r');
  return needs ? '"' + field.replace(/"/g, '""') + '"' : field;
}

export function serializeCsv(rows: string[][], dialect: CsvDialect): string {
  if (rows.length === 0) return dialect.bom ? BOM : '';
  const body = rows
    .map((row) => row.map((f) => quoteField(f, dialect.delimiter)).join(dialect.delimiter))
    .join(dialect.eol);
  return (dialect.bom ? BOM : '') + body + (dialect.trailingNewline ? dialect.eol : '');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/csv/csv.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/csv/csv.ts src/lib/csv/csv.test.ts
git commit -m "feat(csv): RFC 4180 parse/serialize with dialect sniffing"
```

---

### Task 2: rows ↔ GFM table text

**Files:**
- Create: `src/lib/csv/csv-table.ts`
- Test: `src/lib/csv/csv-table.test.ts`

Context: `parseCellsWithPositions(text, lineFrom)` is exported from `src/lib/editor/preview/tables.ts`; it returns trimmed cell text (still encoded: `<br>`, `\|`). `decodeForEdit` (from `src/lib/editor/preview/table-encoding.ts`) turns `<br>` into `\n` and `\|` into `|`. The table widget's own whole-table rewrite uses `markdownTable(grid, { align: null, padding: true })`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/csv/csv-table.test.ts
import { describe, it, expect } from 'vitest';
import { parser, GFM } from '@lezer/markdown';
import { rowsToTable, tableToRows } from './csv-table';

function rows(md: string): string[][] {
  const r = tableToRows(md);
  if (!r.ok) throw new Error(r.error);
  return r.rows;
}

function tableRowCount(md: string): number {
  let n = 0;
  parser.configure(GFM).parse(md).iterate({
    enter: (node) => {
      if (node.name === 'TableRow') n++;
    },
  });
  return n;
}

describe('rowsToTable', () => {
  it('renders header + delimiter + rows, padded, with a trailing newline', () => {
    expect(rowsToTable([['a', 'bb'], ['1', '2']])).toBe('| a | bb |\n| - | -- |\n| 1 | 2  |\n');
  });

  it('pads ragged rows to the widest row', () => {
    expect(rows(rowsToTable([['a', 'b', 'c'], ['1']]))).toEqual([['a', 'b', 'c'], ['1', '', '']]);
  });

  it('encodes pipes and newlines', () => {
    const md = rowsToTable([['h'], ['a|b\nc']]);
    expect(md).toContain('a\\|b<br>c');
    expect(rows(md)).toEqual([['h'], ['a|b\nc']]);
  });

  it('keeps an all-empty row as a table row, with no mark', () => {
    const md = rowsToTable([['a', 'b'], ['', ''], ['x', 'y']]);
    expect(md).not.toMatch(/[^\x20-\x7e\n]/);
    expect(tableRowCount(md)).toBe(2);
    expect(rows(md)).toEqual([['a', 'b'], ['', ''], ['x', 'y']]);
  });

  it('turns zero rows into a one-cell empty header', () => {
    const md = rowsToTable([]);
    expect(rows(md)).toEqual([['']]);
  });

  it('is canonical: re-rendering its own output is a no-op', () => {
    const md = rowsToTable([['a', 'b'], ['', ''], ['x|y', 'l1\nl2']]);
    expect(rowsToTable(rows(md))).toBe(md);
  });
});

describe('tableToRows', () => {
  it('accepts trailing blank lines', () => {
    expect(rows('| a |\n| - |\n| 1 |\n\n\n')).toEqual([['a'], ['1']]);
  });

  it('accepts an unpadded row written by a cell commit', () => {
    expect(rows('| a | b |\n| - | - |\n| 1 |x|\n')).toEqual([['a', 'b'], ['1', 'x']]);
  });

  it.each([
    ['text before', 'hello\n| a |\n| - |\n'],
    ['text after', '| a |\n| - |\nhello\n'],
    ['no delimiter row', '| a |\n| b |\n'],
    ['empty', ''],
    ['second table', '| a |\n| - |\n\n| b |\n| - |\n'],
  ])('rejects %s', (_name, md) => {
    expect(tableToRows(md).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/csv/csv-table.test.ts`
Expected: FAIL — `Failed to resolve import "./csv-table"`.

- [ ] **Step 3: Implement**

```ts
// src/lib/csv/csv-table.ts
import { markdownTable } from 'markdown-table';
import { parseCellsWithPositions } from '../editor/preview/tables';
import { decodeForEdit } from '../editor/preview/table-encoding';

const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export type TableRows = { ok: true; rows: string[][] } | { ok: false; error: string };

function encodeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
}

function decodeCell(text: string): string {
  return decodeForEdit(text);
}

/**
 * CSV rows → the canonical GFM table a CSV buffer holds: first row is the
 * header, rows padded to the widest one, padding identical to the widget's own
 * whole-table rewrite, a trailing newline.
 */
export function rowsToTable(rows: string[][]): string {
  const source = rows.length === 0 ? [['']] : rows;
  const width = Math.max(1, ...source.map((r) => r.length));
  // An all-empty row stays a table row: Lezer GFM keeps `|   |   |` in the
  // Table node (measured with @lezer/markdown 1.6.3), so it needs no mark.
  const grid = source.map((row) => Array.from({ length: width }, (_, i) => encodeCell(row[i] ?? '')));
  return markdownTable(grid, { align: null, padding: true }) + '\n';
}

/**
 * A CSV buffer → CSV rows, or why it is not exactly one table. Cells are read
 * with the widget's own `parseCellsWithPositions`, so the codec sees the cells
 * the user sees (trimmed — leading/trailing spaces of a value do not survive).
 */
export function tableToRows(md: string): TableRows {
  const lines = md.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length < 2) return { ok: false, error: 'not a table' };
  if (!DELIMITER_ROW.test(lines[1])) return { ok: false, error: 'line 2 is not a table delimiter row' };
  const rows: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 1) continue;
    if (!lines[i].trimStart().startsWith('|')) {
      return { ok: false, error: `line ${i + 1} is not a table row` };
    }
    rows.push(parseCellsWithPositions(lines[i], 0).map((c) => decodeCell(c.text)));
  }
  return { ok: true, rows };
}
```

Note on "second table": the blank line between the two tables is not a trailing blank line, and `''.trimStart().startsWith('|')` is false → rejected. That is the intended behaviour.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/csv/csv-table.test.ts`
Expected: PASS. If `rowsToTable` padding in the first test differs from `markdown-table`'s actual output, fix the **expected string** to the library's output (the canonical form is whatever `markdownTable(…, {align:null, padding:true})` produces); never hand-format the table.

- [ ] **Step 5: Commit**

```bash
git add src/lib/csv/csv-table.ts src/lib/csv/csv-table.test.ts
git commit -m "feat(csv): convert CSV rows to and from a canonical GFM table"
```

---

### Task 3: `tableConfig` facet — row cap and placeholder hooks

**Files:**
- Create: `src/lib/editor/preview/table-config.ts`
- Modify: `src/lib/editor/preview/tables.ts` (`addRow` ~line 114, `addColumn` ~line 138, `tableContextAtLine` ~line 879, `moveAfterCommit` new-row ~line 982, `buildTableContext` ~line 1641, `decorateTable` ~line 1697)
- Modify: `src/lib/editor/preview/table-navigation.ts:133` (`newRowMarkdown`)
- Modify: `src/lib/editor/preview/plugin.ts` (~line 148, `update`)
- Test: `src/lib/editor/preview/table-config.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/editor/preview/table-config.test.ts
import { describe, it, expect } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { tableConfig, DEFAULT_TABLE_CONFIG } from './table-config';
import { buildTableContext } from './tables';
import { newRowMarkdown } from './table-navigation';

function table(dataRows: number): string {
  const lines = ['| a | b |', '| - | - |'];
  for (let i = 0; i < dataRows; i++) lines.push(`| ${i} | x |`);
  return lines.join('\n');
}

describe('tableConfig facet', () => {
  it('defaults to today: 500 lines, "-" placeholder', () => {
    const state = EditorState.create({ doc: '' });
    expect(state.facet(tableConfig)).toEqual({ maxLines: 500, placeholder: '-' });
    expect(DEFAULT_TABLE_CONFIG).toEqual({ maxLines: 500, placeholder: '-' });
  });

  it('takes the last provided value', () => {
    const state = EditorState.create({
      extensions: [tableConfig.of({ maxLines: 1, placeholder: 'a' }), tableConfig.of({ maxLines: 2, placeholder: 'b' })],
    });
    expect(state.facet(tableConfig)).toEqual({ maxLines: 2, placeholder: 'b' });
  });
});

describe('buildTableContext cap', () => {
  it('keeps the 500-line cap by default', () => {
    const doc = Text.of(table(499).split('\n')); // 501 lines
    expect(buildTableContext(doc, 0, doc.length)).toBeNull();
  });

  it('draws a 501-line table when the cap is raised', () => {
    const doc = Text.of(table(499).split('\n'));
    expect(buildTableContext(doc, 0, doc.length, Infinity)).not.toBeNull();
  });
});

describe('newRowMarkdown placeholder', () => {
  it('defaults to "-"', () => {
    expect(newRowMarkdown([1, 3])).toBe('| - | -   |');
  });

  it('uses the given placeholder, including an empty one', () => {
    expect(newRowMarkdown([1, 3], 'x')).toBe('| x | x   |');
    expect(newRowMarkdown([1, 3], '')).toBe('|   |     |');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/editor/preview/table-config.test.ts`
Expected: FAIL — `Failed to resolve import "./table-config"`.

- [ ] **Step 3: Create the facet**

```ts
// src/lib/editor/preview/table-config.ts
import { Facet } from '@codemirror/state';

/**
 * What a document type may tune about table rendering, and nothing else.
 *
 * - `maxLines`: tables longer than this stay raw markdown (a performance guard
 *   for prose documents; a CSV document lifts it).
 * - `placeholder`: what a new row's or new column's cells hold. Markdown
 *   keeps `-`; a CSV document uses `''`, since `-` would be written to the
 *   file as data.
 *
 * The default is today's behaviour, so a state that never provides the facet
 * (every markdown document) is unaffected.
 */
export interface TableConfig {
  maxLines: number;
  placeholder: string;
}

export const DEFAULT_TABLE_CONFIG: TableConfig = { maxLines: 500, placeholder: '-' };

export const tableConfig: Facet<TableConfig, TableConfig> = Facet.define({
  combine: (values) => (values.length ? values[values.length - 1] : DEFAULT_TABLE_CONFIG),
});
```

- [ ] **Step 4: Wire it into table code**

`src/lib/editor/preview/table-navigation.ts` — replace `newRowMarkdown`:

```ts
export function newRowMarkdown(colWidths: number[], placeholder: string = '-'): string {
  const cells = colWidths.map((w) => ' ' + placeholder.padEnd(Math.max(w, 1)) + ' ');
  return '|' + cells.join('|') + '|';
}
```

`src/lib/editor/preview/tables.ts`:

1. Add the import next to the other local imports:
   ```ts
   import { tableConfig, DEFAULT_TABLE_CONFIG } from './table-config';
   ```
2. `addRow` — the insert becomes:
   ```ts
   insert: '\n' + newRowMarkdown(ctx.colWidths, view.state.facet(tableConfig).placeholder),
   ```
3. `addColumn` — the loop body becomes:
   ```ts
   grid[i].push(view.state.facet(tableConfig).placeholder);
   ```
4. `tableContextAtLine` — the last line becomes:
   ```ts
   return buildTableContext(doc, node.from, node.to, view.state.facet(tableConfig).maxLines);
   ```
5. `moveAfterCommit`, `new-row` branch — the insert becomes:
   ```ts
   changes: { from: anchor.to, insert: '\n' + newRowMarkdown(ctx.colWidths, view.state.facet(tableConfig).placeholder) },
   ```
6. `buildTableContext` — signature and guard:
   ```ts
   export function buildTableContext(
     doc: Text,
     nodeFrom: number,
     nodeTo: number,
     maxLines: number = DEFAULT_TABLE_CONFIG.maxLines
   ): TableContext | null {
     const startLine = doc.lineAt(nodeFrom);
     const endLine = doc.lineAt(nodeTo);

     // Performance guard — bail before parsing pathological tables. A document
     // type can lift it through the `tableConfig` facet (CSV does).
     if (endLine.number - startLine.number + 1 > maxLines) return null;
   ```
7. `decorateTable`:
   ```ts
   const ctx = buildTableContext(view.state.doc, node.from, node.to, view.state.facet(tableConfig).maxLines);
   ```

`src/lib/editor/preview/plugin.ts` — import `tableConfig` from `./table-config`, and next to `flavourChanged` add:

```ts
      // Same reason as the flavour: a compartment reconfigure that only swaps
      // the table config changes neither document nor selection.
      const tableConfigChanged =
        update.state.facet(tableConfig) !== update.startState.facet(tableConfig);
```

and add `|| tableConfigChanged` to the big `if (...)` condition.

- [ ] **Step 5: Run the new tests and the whole table suite**

Run: `npx vitest run src/lib/editor/preview`
Expected: PASS, no regressions in `tables.test.ts`, `table-navigation.test.ts`, `table-keys.test.ts`, `table-state.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/editor/preview/table-config.ts src/lib/editor/preview/table-config.test.ts src/lib/editor/preview/tables.ts src/lib/editor/preview/table-navigation.ts src/lib/editor/preview/plugin.ts
git commit -m "feat(tables): tableConfig facet for row cap and new-cell placeholder"
```

---

### Task 4: Disk codec

**Files:**
- Create: `src/lib/csv/csv-codec.ts`
- Modify: `src/lib/tauri/commands.ts:18-28` (`readDocument`, `writeDocument`)
- Test: `src/lib/csv/csv-codec.test.ts`

Context: `readDocument`/`writeDocument` are the one read/write boundary for document text (open, tab switch, session restore, external-change reload, agent edits). `fromDisk(raw, fallback)` and `applyLineEnding(text, ending)` are in `src/lib/line-endings.ts`. `resolveExternalChange` in `src/lib/external-change.ts` compares `disk` (decoded) with `baseline` by string equality — an own-save echo must compare equal.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/csv/csv-codec.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isCsvPath,
  isCsvDocument,
  decodeFromDisk,
  encodeForDisk,
  codecRoundTrip,
  resetCsvCodec,
} from './csv-codec';

beforeEach(() => resetCsvCodec());

describe('isCsvPath', () => {
  it.each([
    ['/a/b.csv', true],
    ['/a/b.TSV', true],
    ['/a/b.md', false],
    ['/a/csv', false],
    [null, false],
  ])('%s → %s', (path, expected) => {
    expect(isCsvPath(path)).toBe(expected);
  });
});

describe('decode / encode', () => {
  it('passes non-CSV files through the line-ending path', () => {
    expect(decodeFromDisk('/x.md', 'a\r\nb', 'lf')).toEqual({ text: 'a\nb', lineEnding: 'crlf' });
    expect(encodeForDisk('/x.md', 'a\nb', 'crlf')).toBe('a\r\nb');
  });

  it('decodes CSV to a table and writes it back byte-identical', () => {
    const raw = '﻿name;city\r\nIvan;"Moscow; RU"\r\n';
    const doc = decodeFromDisk('/x.csv', raw, 'lf');
    expect(doc.text.startsWith('| name')).toBe(true);
    expect(doc.lineEnding).toBe('lf');
    expect(encodeForDisk('/x.csv', doc.text, doc.lineEnding)).toBe(raw);
  });

  it('writes an edited table in the remembered dialect', () => {
    const doc = decodeFromDisk('/x.csv', 'a;b\n1;2\n', 'lf');
    const edited = doc.text.replace('| 2 |', '| 2;3 |');
    expect(encodeForDisk('/x.csv', edited, 'lf')).toBe('a;b\n1;"2;3"\n');
  });

  it('uses a tab delimiter for .tsv', () => {
    const doc = decodeFromDisk('/x.tsv', 'a,b\tc\n', 'lf');
    expect(encodeForDisk('/x.tsv', doc.text, 'lf')).toBe('a,b\tc\n');
  });

  it('falls back to raw text when the CSV does not parse', () => {
    const doc = decodeFromDisk('/x.csv', 'a,"open\n', 'lf');
    expect(doc.text).toBe('a,"open\n');
    expect(isCsvDocument('/x.csv')).toBe(false);
    expect(encodeForDisk('/x.csv', 'anything\n', 'lf')).toBe('anything\n');
  });

  it('a later successful read turns the file back into a CSV document', () => {
    decodeFromDisk('/x.csv', 'a,"open\n', 'lf');
    decodeFromDisk('/x.csv', 'a,b\n', 'lf');
    expect(isCsvDocument('/x.csv')).toBe(true);
  });

  it('treats a never-read CSV path (new file) as a CSV document with the default dialect', () => {
    expect(isCsvDocument('/new.csv')).toBe(true);
    expect(encodeForDisk('/new.csv', '| a | b |\n| - | - |\n| 1 | 2 |\n', 'lf')).toBe('a,b\n1,2\n');
  });

  it('refuses to write a CSV buffer that is not one table', () => {
    expect(() => encodeForDisk('/new.csv', '# heading\n', 'lf')).toThrow(/CSV/);
  });
});

describe('codecRoundTrip', () => {
  it('is identity for non-CSV paths', () => {
    expect(codecRoundTrip('/x.md', '| a |\n|-|\n')).toBe('| a |\n|-|\n');
  });

  it('equals what the next read of the saved file returns', () => {
    const doc = decodeFromDisk('/x.csv', 'a,b\n1,2\n', 'lf');
    const edited = doc.text.replace('| 2 |', '|xyz|'); // non-canonical, as a cell commit leaves it
    const written = encodeForDisk('/x.csv', edited, 'lf');
    const echo = decodeFromDisk('/x.csv', written, 'lf').text;
    expect(codecRoundTrip('/x.csv', edited)).toBe(echo);
    expect(echo).not.toBe(edited);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/csv/csv-codec.test.ts`
Expected: FAIL — `Failed to resolve import "./csv-codec"`.

- [ ] **Step 3: Implement the codec**

```ts
// src/lib/csv/csv-codec.ts
import { applyLineEnding, fromDisk, type DiskDocument, type LineEnding } from '../line-endings';
import { parseCsv, serializeCsv, type CsvDialect } from './csv';
import { rowsToTable, tableToRows } from './csv-table';

/**
 * CSV at the disk boundary. A CSV document's buffer is a GFM table; this is
 * the only place that knows the file on disk is CSV.
 *
 * Per-path state: the dialect the file was read in, or `'raw'` when it did not
 * parse — such a file is shown and saved as plain text. A path with no entry
 * (a new file) is a CSV document with the extension's default dialect.
 */
const state = new Map<string, CsvDialect | 'raw'>();

function extOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isCsvPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const ext = extOf(path);
  return ext === 'csv' || ext === 'tsv';
}

/** Is this path edited as a table (as opposed to a CSV that failed to parse)? */
export function isCsvDocument(path: string | null | undefined): boolean {
  return isCsvPath(path) && state.get(path as string) !== 'raw';
}

function defaultDialect(path: string): CsvDialect {
  return { delimiter: extOf(path) === 'tsv' ? '\t' : ',', bom: false, eol: '\n', trailingNewline: true };
}

function parseFor(path: string, raw: string) {
  return parseCsv(raw, extOf(path) === 'tsv' ? { delimiter: '\t' } : undefined);
}

export function decodeFromDisk(path: string, raw: string, fallback: LineEnding): DiskDocument {
  if (!isCsvPath(path)) return fromDisk(raw, fallback);
  const parsed = parseFor(path, raw);
  if (!parsed.ok) {
    state.set(path, 'raw');
    return fromDisk(raw, fallback);
  }
  state.set(path, parsed.dialect);
  // CSV owns its line endings (the dialect); the buffer is LF table text.
  return { text: rowsToTable(parsed.rows), lineEnding: 'lf' };
}

export function encodeForDisk(path: string, text: string, lineEnding: LineEnding): string {
  if (!isCsvDocument(path)) return applyLineEnding(text, lineEnding);
  const table = tableToRows(text);
  if (!table.ok) throw new Error(`Cannot save as CSV: ${table.error}`);
  const entry = state.get(path);
  const dialect = entry && entry !== 'raw' ? entry : defaultDialect(path);
  return serializeCsv(table.rows, dialect);
}

/**
 * What the next read of `path` returns after `text` is saved to it — the
 * value a save must store as the disk baseline. A cell commit leaves the
 * table unpadded, the file comes back canonical, and with the buffer as the
 * baseline our own save's echo would read as an external change.
 */
export function codecRoundTrip(path: string | null, text: string): string {
  if (!path || !isCsvDocument(path)) return text;
  let written: string;
  try {
    written = encodeForDisk(path, text, 'lf');
  } catch {
    return text;
  }
  const parsed = parseFor(path, written);
  return parsed.ok ? rowsToTable(parsed.rows) : text;
}

/** Tests only. */
export function resetCsvCodec(): void {
  state.clear();
}
```

- [ ] **Step 4: Route the disk boundary through the codec**

In `src/lib/tauri/commands.ts` add `import { decodeFromDisk, encodeForDisk } from '../csv/csv-codec';`, drop `applyLineEnding, fromDisk` from the `line-endings` import if they become unused (keep `type DiskDocument, type LineEnding`), and replace the two bodies:

```ts
export async function readDocument(path: string, fallback: LineEnding = 'lf'): Promise<DiskDocument> {
  return decodeFromDisk(path, await invoke<string>('read_file', { path }), fallback);
}

export async function writeDocument(path: string, text: string, lineEnding: LineEnding): Promise<void> {
  return invoke('write_file', { path, content: encodeForDisk(path, text, lineEnding) });
}
```

Extend both doc comments with one sentence: "A `.csv`/`.tsv` path is decoded to / encoded from a GFM table here — see `csv/csv-codec.ts`."

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/lib/csv src/lib/tauri`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/csv/csv-codec.ts src/lib/csv/csv-codec.test.ts src/lib/tauri/commands.ts
git commit -m "feat(csv): decode and encode CSV at the document disk boundary"
```

---

### Task 5: Edit guard + CSV extension bundle

**Files:**
- Create: `src/lib/csv/csv-guard.ts`
- Create: `src/lib/csv/csv-extensions.ts`
- Test: `src/lib/csv/csv-guard.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/csv/csv-guard.test.ts
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { csvEditGuard } from './csv-guard';
import { rowsToTable } from './csv-table';

const DOC = rowsToTable([['a', 'b'], ['1', '2']]); // '| a | b |\n| - | - |\n| 1 | 2 |\n'

function stateOf(doc = DOC) {
  return EditorState.create({ doc, extensions: [csvEditGuard, history()] });
}

describe('csvEditGuard', () => {
  it('drops typing after the table', () => {
    const s = stateOf();
    const next = s.update({ changes: { from: s.doc.length, insert: 'hello' } }).state;
    expect(next.doc.toString()).toBe(DOC);
  });

  it('drops text inserted before the table', () => {
    const s = stateOf();
    expect(s.update({ changes: { from: 0, insert: '# t\n' } }).state.doc.toString()).toBe(DOC);
  });

  it('lets a cell edit through', () => {
    const s = stateOf();
    const at = DOC.indexOf('1');
    const next = s.update({ changes: { from: at, to: at + 1, insert: 'one' } }).state;
    expect(next.doc.toString()).toContain('| one |');
  });

  it('lets a new row through', () => {
    const s = stateOf();
    const end = DOC.length - 1; // before the trailing newline
    const next = s.update({ changes: { from: end, insert: '\n| x | y |' } }).state;
    expect(next.doc.lines).toBe(5);
  });

  it('lets a row whose cells were all emptied through', () => {
    const s = stateOf();
    const row = s.doc.line(3);
    const next = s.update({ changes: { from: row.from, to: row.to, insert: '|   |   |' } }).state;
    expect(next.doc.line(3).text).toBe('|   |   |');
  });

  it('lets undo through', () => {
    let s = stateOf();
    const at = DOC.indexOf('1');
    s = s.update({ changes: { from: at, to: at + 1, insert: 'one' }, userEvent: 'input' }).state;
    let undone = s;
    undo({ state: s, dispatch: (tr) => { undone = tr.state; } });
    expect(undone.doc.toString()).toBe(DOC);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/csv/csv-guard.test.ts`
Expected: FAIL — `Failed to resolve import "./csv-guard"`.

- [ ] **Step 3: Implement the guard**

```ts
// src/lib/csv/csv-guard.ts
import { EditorState } from '@codemirror/state';
import { tableToRows } from './csv-table';

/**
 * A CSV document's buffer is exactly one GFM table, because that is all a CSV
 * file can hold. Any edit that would leave something else — text above or
 * below, a second table, a pasted paragraph — is dropped.
 *
 * Undo/redo pass untouched: they replay states this filter already accepted.
 */
export const csvEditGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) return tr;
  return tableToRows(tr.newDoc.toString()).ok ? tr : [];
});
```

- [ ] **Step 4: Implement the extension bundle**

```ts
// src/lib/csv/csv-extensions.ts
import type { Extension } from '@codemirror/state';
import { livePreviewPlugin } from '../editor/preview/plugin';
import { flavourFacet, LIVE_PREVIEW } from '../editor/preview/flavour';
import { tableConfig } from '../editor/preview/table-config';
import { csvEditGuard } from './csv-guard';

/**
 * What a CSV tab puts in the preview compartment, whatever the engine: the
 * table preview, no cap on rows, empty (not `-`) new cells, and the
 * one-table guard. One stable array — a compartment reconfigure with the same
 * value is a no-op.
 */
export const csvPreviewExtensions: Extension = [
  livePreviewPlugin,
  flavourFacet.of(LIVE_PREVIEW),
  tableConfig.of({ maxLines: Infinity, placeholder: '' }),
  csvEditGuard,
];
```

Check the actual export name of the live-preview plugin in `src/lib/editor/preview/plugin.ts` and where `App.svelte` imports it from; use the same import. If it is exported from another module, import from there.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/lib/csv`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/csv/csv-guard.ts src/lib/csv/csv-guard.test.ts src/lib/csv/csv-extensions.ts
git commit -m "feat(csv): keep a CSV buffer to exactly one table"
```

---

### Task 6: CSV document kind in the app

**Files:**
- Modify: `src/lib/editor/file-language.ts` (`PreviewKind`, `previewKindFor` ~line 79-92)
- Modify: `src/lib/csv/csv-codec.ts` (add `documentPreviewKind`)
- Modify: `src/App.svelte` (`setActiveDocument` ~647, `applyDocumentConfig` ~671, `doSave` ~427, `applyPreviewConfig` ~2950)
- Modify: `src/styles/editor.css` (next to the `.cm-code-file-mode` block ~1482)
- Test: the existing `file-language` test file (find it with `ls src/lib/editor/file-language*.test.ts`), `src/lib/csv/csv-codec.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the file-language test file:

```ts
import { previewKindFor } from './file-language';

describe('previewKindFor csv', () => {
  it.each(['/d/a.csv', '/d/a.TSV'])('%s is csv', (p) => {
    expect(previewKindFor(p)).toBe('csv');
  });
});
```

Add to `src/lib/csv/csv-codec.test.ts` (import `documentPreviewKind`):

```ts
describe('documentPreviewKind', () => {
  it('is csv for a parsed CSV and code for one that failed', () => {
    decodeFromDisk('/ok.csv', 'a,b\n', 'lf');
    decodeFromDisk('/bad.csv', 'a,"open\n', 'lf');
    expect(documentPreviewKind('/ok.csv')).toBe('csv');
    expect(documentPreviewKind('/bad.csv')).toBe('code');
    expect(documentPreviewKind('/x.md')).toBe('markdown');
    expect(documentPreviewKind(null)).toBe('markdown');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/editor/file-language src/lib/csv/csv-codec.test.ts`
Expected: FAIL (`'code'` ≠ `'csv'`; `documentPreviewKind` not exported).

- [ ] **Step 3: Implement the kind**

`file-language.ts`:

```ts
export type PreviewKind = 'markdown' | 'env' | 'code' | 'shell' | 'csv';
```

and in `previewKindFor`, right after the env check:

```ts
  if (ext === 'csv' || ext === 'tsv') return 'csv';
```

Update its doc comment: "`.csv`/`.tsv` are `'csv'` — a table buffer, see `csv/csv-codec.ts`."

`csv-codec.ts`:

```ts
import { previewKindFor, type PreviewKind } from '../editor/file-language';

/**
 * The preview kind a document actually gets: a CSV that failed to parse is
 * shown as plain text (`'code'`), never as a table it cannot be saved from.
 */
export function documentPreviewKind(path: string | null): PreviewKind {
  const kind = previewKindFor(path);
  return kind === 'csv' && !isCsvDocument(path) ? 'code' : kind;
}
```

Run `npx vitest run src/lib/editor/file-language src/lib/csv` → PASS. Run `npm run check` and fix every place that switches exhaustively on `PreviewKind`.

- [ ] **Step 4: Wire the app**

`src/App.svelte` — import `{ codecRoundTrip, documentPreviewKind }` from `./lib/csv/csv-codec` and `{ csvPreviewExtensions }` from `./lib/csv/csv-extensions`.

1. `setActiveDocument`: `activePreview = documentPreviewKind(path);`
2. `applyDocumentConfig`: `const kind = documentPreviewKind(path);`, then the first branch becomes:
   ```ts
   editorHandle?.view?.dom.classList.toggle('cm-csv-file-mode', kind === 'csv');
   if (kind === 'env') {
     editorHandle?.setEnvMode(true);
   } else if (kind === 'markdown' || kind === 'csv') {
   ```
   (the body of the markdown branch is unchanged).
3. `doSave`: replace `diskBaseline = content;` with
   ```ts
   // For a CSV file the next read returns the canonical table, not the
   // buffer as typed — store that, or our own save's echo reads as an
   // external change (see csv-codec.ts `codecRoundTrip`).
   diskBaseline = codecRoundTrip(path, content);
   ```
4. `applyPreviewConfig`: right after `if (!v) return;` insert:
   ```ts
   // A CSV tab is a table whatever the engine: Raw would expose a markdown
   // table the file does not contain, and the engine is a window-wide
   // setting a tab cannot veto.
   if (activePreview === 'csv') {
     v.dispatch({ effects: previewCompartment.reconfigure(csvPreviewExtensions) });
     return;
   }
   ```
   and change `if (activePreview !== 'markdown') {` to keep `'csv'` out of it (it already returned above, so no change is needed there unless `npm run check` complains about the union).

`src/styles/editor.css` after the `.cm-code-file-mode` rules:

```css
/* A CSV tab holds exactly one table: the block "+" menu has nothing to add. */
.cm-csv-file-mode .cm-hover-gutter {
  display: none;
}
```

- [ ] **Step 5: Verify**

Run: `npm run check` → 0 errors. Run: `npx vitest run --dir src` → all pass (compare the count with the run before this task; nothing previously green may fail).

- [ ] **Step 6: Commit**

```bash
git add src/lib/editor/file-language.ts src/lib/editor/file-language*.test.ts src/lib/csv/csv-codec.ts src/lib/csv/csv-codec.test.ts src/App.svelte src/styles/editor.css
git commit -m "feat(csv): open .csv/.tsv as a table document"
```

---

### Task 7: AI edit refusal, file associations, dialog filter

**Files:**
- Modify: `src/lib/tabs/agent-commands.ts` (`AGENT_ERRORS` ~line 34, `handle` ~line 392)
- Test: `src/lib/tabs/agent-commands.test.ts`
- Modify: `src-tauri/tauri.conf.json` (`bundle.fileAssociations`, line ~47)
- Modify: `src/lib/tauri/commands.ts` (`FILE_FILTERS`, lines ~98-100)

- [ ] **Step 1: Write the failing test**

In `agent-commands.test.ts`, follow the file's existing harness for an `edit` command (find a test that sends `cmd: 'edit'` and reuse its setup). Add:

```ts
it('refuses edit on a CSV file before any tab moves', async () => {
  // build the harness exactly as the neighbouring edit tests do, then:
  await handler.handle({ ...editPayload, path: '/d/data.csv' });
  expect(lastResponse()).toEqual({ ok: false, error: AGENT_ERRORS.csvEdit });
  // and assert no tab method was called (use the same spy the
  // "unsupported command" test uses to prove nothing moved)
});
```

Adapt names (`handler`, `editPayload`, `lastResponse`) to what the test file actually uses; keep the two assertions: the error response, and that no tab moved.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/tabs/agent-commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`AGENT_ERRORS` gains:

```ts
  csvEdit: 'couplet edit does not support CSV files yet',
```

In `handle`, right after the `VERBS` check:

```ts
      // A CSV tab's buffer is a markdown table; an agent's CSV text diffed
      // into it would be saved as table rows. Refused until edit learns the
      // codec — before anything moves, like an unknown verb.
      if (payload.cmd === 'edit' && isCsvPath(payload.path)) {
        await respond(payload, { ok: false, error: AGENT_ERRORS.csvEdit });
        return;
      }
```

with `import { isCsvPath } from '../csv/csv-codec';`.

- [ ] **Step 4: Associations and filters**

`src-tauri/tauri.conf.json`, append to `bundle.fileAssociations`:

```json
      {
        "ext": ["csv"],
        "mimeType": "text/csv",
        "description": "CSV Document"
      },
      {
        "ext": ["tsv"],
        "mimeType": "text/tab-separated-values",
        "description": "TSV Document"
      }
```

`src/lib/tauri/commands.ts` `FILE_FILTERS`: add `'tsv'` right after `'csv'` in both the "All Supported" and "Data" entries.

- [ ] **Step 5: Verify**

Run: `npx vitest run src/lib/tabs/agent-commands.test.ts` → PASS.
Run: `cd src-tauri && cargo test` → PASS (config still valid).

- [ ] **Step 6: Commit**

```bash
git add src/lib/tabs/agent-commands.ts src/lib/tabs/agent-commands.test.ts src-tauri/tauri.conf.json src/lib/tauri/commands.ts
git commit -m "feat(csv): refuse agent edits on CSV files; register csv/tsv"
```

---

### Task 8: Live verification and docs

**Files:**
- Modify: `CLAUDE.md` (Architecture tree + one Gotchas entry)
- Modify: `src/lib/editor/preview/CLAUDE.md` (short "CSV documents" section)

- [ ] **Step 1: Browser check (`npm run dev`, Playwright with `chromium.launch({ channel: 'chrome' })` or the Playwright MCP)**

At `http://localhost:1420`, reach the view with `document.querySelector('.cm-content').cmTile.root.view`. There is no Tauri I/O in the browser, so drive the pieces directly via `import()` of `/src/lib/csv/csv-codec.ts` and `/src/lib/csv/csv-extensions.ts` from the page (Vite serves source modules):
- install `csvPreviewExtensions` through `previewCompartment` (import `/src/lib/editor/setup.ts`), set the doc to `decodeFromDisk('/t.csv', '<csv>', 'lf').text`;
- confirm `.cm-md-table-row` count = records; type after the table → doc unchanged; click the table's add-row "+" → the new row is drawn and shows no `-`; double-click one of its cells, type, commit → the value lands in that cell; and `encodeForDisk('/t.csv', doc, 'lf')` ends with `,\n` for a 2-column file;
- 1 200-row CSV renders (above the markdown 500-line cap).
Screenshot to `$CLAUDE_JOB_DIR/tmp/`. Stop the dev server afterwards.

- [ ] **Step 2: Real app check (`npm run dev:app -- --features mcp-bridge` if the bridge is needed; otherwise plain `npm run dev:app`)**

Never `npm run tauri dev`. Window title `csv · local`. Use a scratch dir under `$CLAUDE_JOB_DIR/tmp/csv-check/`:
- `sample.csv`: `;`-delimited, CRLF, BOM, one quoted field with an embedded newline, one empty row.
- Open it (`target/debug` dev binary CLI path, or File → Open in the dev app), edit one cell, add a row, wait for autosave.
- `xxd sample.csv | head` — BOM, `;`, CRLF preserved; only the edited cell and the new row differ (`diff` against a copy).
- No "file changed on disk" reload/flicker after autosave (watch the console log / `read_logs`).
- Generate 2 000 and 10 000-row files; time a cell commit (performance.now around the commit via the bridge's eval pattern from the root CLAUDE.md). Record the numbers.
Kill the dev app with `pkill -f "debug/md-mini"` when done.

- [ ] **Step 3: Docs**

Root `CLAUDE.md`, Architecture tree under `src/lib/`:

```
  lib/csv/              # CSV documents: the buffer is a GFM table, CSV only at the disk boundary
    csv.ts              # RFC 4180 parse/serialize + dialect (delimiter, BOM, eol)
    csv-table.ts        # rows ↔ canonical GFM table
    csv-codec.ts        # readDocument/writeDocument hook, per-path dialect, save baseline
    csv-guard.ts        # transactionFilter: the buffer stays exactly one table
```

Root `CLAUDE.md`, Gotchas — one entry:

```
- **A CSV document's save baseline is `codecRoundTrip(buffer)`, not the buffer.** A cell commit leaves the table unpadded; the saved CSV reads back as the canonical padded table. With the buffer as `diskBaseline`, the watcher's echo of our own save compares unequal and `resolveExternalChange` reloads the buffer under the user. `doSave` stores what the next read will return instead.
```

`src/lib/editor/preview/CLAUDE.md` — add a section "CSV documents": the `tableConfig` facet is the only CSV-facing hook in table code (`maxLines`, `placeholder`); the default is today's behaviour; CSV supplies `Infinity` and `''`; never branch on "is CSV" inside `tables.ts`.

Root `CLAUDE.md` gotcha "Lezer GFM tables exclude whitespace-only rows" and the matching lines in `preview/CLAUDE.md` (add-row strategy, "whitespace-only cells get excluded"): append a dated correction without changing markdown behaviour — "Re-measured 2026-10-04 with `@lezer/markdown` 1.6.3: an all-empty row `|   |   |` IS kept in the `Table` node and drawn by the widget (middle, end, no trailing newline, empty header). Markdown still inserts `-` as a visible prompt; CSV inserts empty cells." Fix the matching comment in `tables.ts` `addRow` the same way (comment only).

- [ ] **Step 4: Full verification**

Run: `npx vitest run --dir src`, `npm run check`, `cd src-tauri && cargo test`, `cargo clippy --manifest-path src-tauri/Cargo.toml`. All green.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md src/lib/editor/preview/CLAUDE.md
git commit -m "docs(csv): architecture, baseline gotcha, tableConfig hook"
```
