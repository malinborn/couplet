import { describe, it, expect } from 'vitest';
import { parser, GFM } from '@lezer/markdown';
import { rowsToTable, tableToRows, EMPTY_CELL_MARK } from './csv-table';

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

  it('marks an all-empty row so Lezer keeps it in the table', () => {
    const md = rowsToTable([['a', 'b'], ['', ''], ['x', 'y']]);
    expect(md).toContain(EMPTY_CELL_MARK);
    expect(tableRowCount(md)).toBe(2);
    expect(rows(md)).toEqual([['a', 'b'], ['', ''], ['x', 'y']]);
  });

  it('turns zero rows into a one-cell marked header', () => {
    const md = rowsToTable([]);
    expect(rows(md)).toEqual([['']]);
  });

  it('is canonical: re-rendering its own output is a no-op', () => {
    const md = rowsToTable([['a', 'b'], ['', ''], ['x|y', 'l1\nl2']]);
    expect(rowsToTable(rows(md))).toBe(md);
  });
});

describe('tableToRows', () => {
  it('strips every empty-cell mark from values', () => {
    const md = `| h |\n| - |\n| ${EMPTY_CELL_MARK}foo${EMPTY_CELL_MARK} |\n`;
    expect(rows(md)).toEqual([['h'], ['foo']]);
  });

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
