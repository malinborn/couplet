import { describe, it, expect } from 'vitest';
import {
  stepColumn,
  nextNavigableRow,
  clampColumn,
  planTableExit,
  newRowMarkdown,
  rowInsertAfter,
  type NavRow,
} from './table-navigation';

const header: NavRow = { isDelimiter: false, cellCount: 3 };
const delim: NavRow = { isDelimiter: true, cellCount: 3 };
const data = (n = 3): NavRow => ({ isDelimiter: false, cellCount: n });

describe('stepColumn', () => {
  it('moves right and left', () => {
    expect(stepColumn(0, 3, 1)).toBe(1);
    expect(stepColumn(2, 3, -1)).toBe(1);
  });

  it('wraps inside the row rather than changing rows', () => {
    expect(stepColumn(2, 3, 1)).toBe(0);
    expect(stepColumn(0, 3, -1)).toBe(2);
  });

  it('stays put in a single-column table', () => {
    expect(stepColumn(0, 1, 1)).toBe(0);
    expect(stepColumn(0, 1, -1)).toBe(0);
  });

  it('does not divide by zero on a row with no cells', () => {
    expect(stepColumn(0, 0, 1)).toBe(0);
  });
});

describe('nextNavigableRow', () => {
  const rows = [header, delim, data(), data()];

  it('skips the delimiter when leaving the header', () => {
    expect(nextNavigableRow(rows, 0)).toBe(2);
  });

  it('walks data rows one by one', () => {
    expect(nextNavigableRow(rows, 2)).toBe(3);
  });

  it('answers null on the last row — the signal to leave the table', () => {
    expect(nextNavigableRow(rows, 3)).toBeNull();
  });

  it('answers null for a single-row table, where the header is the last row', () => {
    expect(nextNavigableRow([header, delim], 0)).toBeNull();
  });

  it('skips a cell-less row — a bare paragraph GFM swallowed into the table', () => {
    const paragraph: NavRow = { isDelimiter: false, cellCount: 0 };
    expect(nextNavigableRow([header, delim, data(), paragraph], 2)).toBeNull();
    expect(nextNavigableRow([header, delim, paragraph, data()], 0)).toBe(3);
  });
});

describe('clampColumn', () => {
  it('keeps the column when the target row is wide enough', () => {
    expect(clampColumn(2, 3)).toBe(2);
  });

  it('clamps into a ragged shorter row', () => {
    expect(clampColumn(2, 2)).toBe(1);
  });

  it('never answers negative', () => {
    expect(clampColumn(2, 0)).toBe(0);
  });
});

describe('planTableExit', () => {
  it('appends a line when the table ends the file', () => {
    expect(planTableExit(100, null)).toEqual({ insert: '\n', at: 100, caret: 101 });
  });

  it('reuses an empty line that is already there — no second one', () => {
    expect(planTableExit(100, { from: 101, to: 101, text: '' })).toEqual({
      insert: '',
      at: 100,
      caret: 101,
    });
  });

  it('treats a whitespace-only line as the empty line', () => {
    expect(planTableExit(100, { from: 101, to: 104, text: '   ' })).toEqual({
      insert: '',
      at: 100,
      caret: 101,
    });
  });

  it('opens one line when text follows the table directly', () => {
    expect(planTableExit(100, { from: 101, to: 110, text: 'Следующий' })).toEqual({
      insert: '\n',
      at: 100,
      caret: 101,
    });
  });
});

describe('newRowMarkdown', () => {
  it('uses visible placeholders, because Lezer drops whitespace-only rows', () => {
    expect(newRowMarkdown([3, 5])).toBe('| -   | -     |');
  });

  it('pads a zero-width column to one character', () => {
    expect(newRowMarkdown([0])).toBe('| - |');
  });
});

describe('rowInsertAfter', () => {
  const rows = [header, delim, data(), data()];

  it('puts a row added from the header below the delimiter, not above it', () => {
    expect(rowInsertAfter(rows, 0)).toBe(1);
  });

  it('puts a row added from a data row directly below it', () => {
    expect(rowInsertAfter(rows, 2)).toBe(2);
    expect(rowInsertAfter(rows, 3)).toBe(3);
  });
});
