import { describe, it, expect } from 'vitest';
import { parser, GFM } from '@lezer/markdown';
import { rowsToTable, tableToRows } from './csv-table';

function lezerCells(md: string): string[] {
  const cells: string[] = [];
  parser.configure(GFM).parse(md).iterate({
    enter: (node) => {
      if (node.name === 'TableCell') cells.push(md.slice(node.from, node.to));
    },
  });
  return cells;
}

function rows(md: string): string[][] {
  const r = tableToRows(md);
  if (!r.ok) throw new Error(r.error);
  return r.rows;
}

/** Data rows only: Lezer emits the first line as `TableHeader`, not `TableRow`. */
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
    // Two data rows — the empty one and `x | y`; the header is not a TableRow.
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

describe('documented limitations', () => {
  it('trims leading and trailing spaces of a value', () => {
    expect(rows(rowsToTable([['h'], [' a ']]))).toEqual([['h'], ['a']]);
  });

  it('reads a literal <br> in a value back as a newline', () => {
    expect(rows(rowsToTable([['h'], ['x<br>y']]))).toEqual([['h'], ['x\ny']]);
  });

  it('reads CRLF inside a value back as LF', () => {
    expect(rows(rowsToTable([['h'], ['l1\r\nl2']]))).toEqual([['h'], ['l1\nl2']]);
  });

  it('round-trips a literal \\| unchanged, though Lezer splits that cell in two', () => {
    // The value `a\|b` is written as `a\\|b`. The widget's cell parser (and so
    // `tableToRows`) treats the `|` after a backslash as escaped: one cell,
    // decoded back to `a\|b`. Lezer reads `\\` as an escaped backslash and the
    // `|` as a cell boundary: cells `a\\` and `b`, one more than the header.
    const md = rowsToTable([['h1', 'h2'], ['a\\|b', 'c']]);
    expect(md).toContain('a\\\\|b');
    expect(rows(md)).toEqual([['h1', 'h2'], ['a\\|b', 'c']]);
    expect(lezerCells(md)).toEqual(['h1', 'h2', 'a\\\\', 'b', 'c']);
  });
});

describe('tableToRows', () => {
  it('accepts trailing blank lines', () => {
    expect(rows('| a |\n| - |\n| 1 |\n\n\n')).toEqual([['a'], ['1']]);
  });

  it('accepts a row narrower than the header', () => {
    expect(rows('| a | b |\n| - | - |\n| 1 |\n')).toEqual([['a', 'b'], ['1']]);
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
    ['delimiter narrower than header', '| a | b |\n| - |\n| 1 | 2 |\n'],
    ['delimiter wider than header', '| a |\n| - | - |\n'],
    ['delimiter without a leading pipe', '| a | b |\n- | - |\n'],
    ['unclosed header', '| a | b\n| - | - |\n'],
    ['unclosed delimiter', '| a | b |\n| - | -\n'],
    ['unclosed row', '| a | b |\n| - | - |\n| 1 | 2\n'],
    ['row closed by an escaped pipe', '| a | b |\n| - | - |\n| 1 | 2 \\|\n'],
    ['row wider than the header', '| a |\n| - |\n| 1 | 2 |\n'],
  ])('rejects %s', (_name, md) => {
    expect(tableToRows(md).ok).toBe(false);
  });
});
