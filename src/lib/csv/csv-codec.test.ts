import { describe, it, expect } from 'vitest';
import {
  isTableBuffer,
  decodeFromDisk,
  encodeForDisk,
  documentPreviewKind,
  newFileText,
  csvTableRefusal,
  csvOpensReadOnly,
  CSV_TABLE_MAX_ROWS,
} from './csv-codec';
import { rowsToTable } from './csv-table';

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n';

describe('isTableBuffer', () => {
  it.each([
    ['/x.csv', TABLE, true],
    ['/x.tsv', TABLE, true],
    ['/x.csv', '# note\nsome text, more\n', false],
    ['/x.csv', 'a,"open\n', false],
    ['/x.md', TABLE, false],
  ])('%s with %j → %s', (path, text, expected) => {
    expect(isTableBuffer(path, text)).toBe(expected);
  });

  it('is exactly the rule encodeForDisk encodes by', () => {
    for (const text of [TABLE, '# note\nsome text, more\n', 'a,"open\n']) {
      const encoded = encodeForDisk('/x.csv', text, 'lf', null) !== text;
      expect(encoded).toBe(isTableBuffer('/x.csv', text));
    }
  });
});

describe('decodeFromDisk', () => {
  it('passes non-CSV files through the line-ending path', () => {
    expect(decodeFromDisk('/x.md', 'a\r\nb', 'lf')).toEqual({ text: 'a\nb', lineEnding: 'crlf' });
  });

  it('decodes CSV to a table, LF', () => {
    const doc = decodeFromDisk('/x.csv', 'a;b\r\n1;2\r\n', 'lf');
    expect(doc).toEqual({ text: TABLE, lineEnding: 'lf' });
  });

  it('a CSV that does not parse comes back as its text, like any file', () => {
    expect(decodeFromDisk('/x.csv', 'a,"open\r\n', 'lf')).toEqual({ text: 'a,"open\n', lineEnding: 'crlf' });
  });

  it('uses a tab delimiter for .tsv', () => {
    expect(decodeFromDisk('/x.tsv', 'a,b\tc\n', 'lf').text).toBe(rowsToTable([['a,b', 'c']]));
  });
});

describe('encodeForDisk', () => {
  it('passes non-CSV files through the line-ending path', () => {
    expect(encodeForDisk('/x.md', 'a\nb', 'crlf', null)).toBe('a\r\nb');
  });

  it('round-trips a CSV byte-identical through the file it replaces', () => {
    const raw = '\uFEFFname;city\r\nIvan;"Moscow; RU"\r\n';
    const doc = decodeFromDisk('/x.csv', raw, 'lf');
    expect(encodeForDisk('/x.csv', doc.text, doc.lineEnding, raw)).toBe(raw);
  });

  it('takes the dialect from `current`: `;` + BOM + CRLF', () => {
    expect(encodeForDisk('/x.csv', TABLE, 'lf', '\uFEFFx;y\r\n')).toBe('\uFEFFa;b\r\n1;2\r\n');
  });

  it('takes the dialect from a `current` that no longer parses', () => {
    expect(encodeForDisk('/x.csv', TABLE, 'lf', 'a;b\r\n"open')).toBe('a;b\r\n1;2');
  });

  it('no current file → the extension default', () => {
    expect(encodeForDisk('/x.csv', TABLE, 'lf', null)).toBe('a,b\n1,2\n');
    expect(encodeForDisk('/x.tsv', TABLE, 'lf', null)).toBe('a\tb\n1\t2\n');
  });

  it('a .tsv keeps the tab delimiter whatever the current file sniffs as', () => {
    expect(encodeForDisk('/x.tsv', TABLE, 'lf', 'p,q\tr\n')).toBe('a\tb\n1\t2\n');
  });

  it('writes an edited table in the dialect of the file it replaces', () => {
    const raw = 'a;b\n1;2\n';
    const edited = decodeFromDisk('/x.csv', raw, 'lf').text.replace('| 2 |', '| 2;3 |');
    expect(encodeForDisk('/x.csv', edited, 'lf', raw)).toBe('a;b\n1;"2;3"\n');
  });

  it('a buffer that is not one table is written as is, in its line ending', () => {
    expect(encodeForDisk('/x.csv', 'a,"open\n', 'crlf', 'a,"open\r\n')).toBe('a,"open\r\n');
    expect(encodeForDisk('/x.csv', '# heading\n', 'lf', null)).toBe('# heading\n');
  });

  it('an empty table saves as an empty file', () => {
    expect(encodeForDisk('/new.csv', rowsToTable([]), 'lf', null)).toBe('');
    expect(encodeForDisk('/x.csv', decodeFromDisk('/x.csv', '', 'lf').text, 'lf', '')).toBe('');
  });
});

describe('no state', () => {
  it('a read never changes how a later write behaves', () => {
    decodeFromDisk('/x.csv', 'a,"open\n', 'lf'); // fails to parse
    expect(encodeForDisk('/x.csv', TABLE, 'lf', null)).toBe('a,b\n1,2\n');
  });

  it('two spellings of one path encode identically', () => {
    const raw = '\uFEFFa;b\r\n1;2\r\n';
    decodeFromDisk('/tmp/x.csv', raw, 'lf');
    const a = encodeForDisk('/tmp/x.csv', TABLE, 'lf', raw);
    const b = encodeForDisk('/private/tmp/x.csv', TABLE, 'lf', raw);
    expect(b).toBe(a);
    expect(b).toBe(raw);
  });
});

describe('documentPreviewKind', () => {
  it.each([
    ['/x.csv', TABLE, 'csv'],
    ['/x.tsv', TABLE, 'csv'],
    ['/x.csv', 'a,"open\n', 'code'],
    ['/x.md', TABLE, 'markdown'],
    [null, TABLE, 'markdown'],
    ['/x.rs', 'fn main() {}', 'code'],
  ] as const)('%s with %j → %s', (path, text, expected) => {
    expect(documentPreviewKind(path, text)).toBe(expected);
  });
});

describe('newFileText', () => {
  it('a CSV path that does not exist yet opens as an empty table', () => {
    expect(newFileText('/new.csv')).toBe(rowsToTable([]));
    expect(documentPreviewKind('/new.csv', newFileText('/new.csv'))).toBe('csv');
  });

  it('any other path opens empty, as before', () => {
    expect(newFileText('/new.md')).toBe('');
  });
});

/** A header plus `dataRows` records. */
function csvWith(dataRows: number, eol = '\n'): string {
  const lines = ['id,name'];
  for (let i = 0; i < dataRows; i++) lines.push(`${i},n ${i}`);
  return lines.join(eol) + eol;
}

describe('CSV_TABLE_MAX_ROWS', () => {
  it('counts data rows: at the cap the file is still a table', () => {
    const doc = decodeFromDisk('/x.csv', csvWith(CSV_TABLE_MAX_ROWS), 'lf');
    expect(doc.lineEnding).toBe('lf');
    expect(doc.text.startsWith('| id')).toBe(true);
    expect(documentPreviewKind('/x.csv', doc.text)).toBe('csv');
  });

  it('one row above the cap decodes to the raw text, like a parse failure', () => {
    const raw = csvWith(CSV_TABLE_MAX_ROWS + 1, '\r\n');
    const doc = decodeFromDisk('/x.csv', raw, 'lf');
    expect(doc).toEqual({ text: raw.replace(/\r\n/g, '\n'), lineEnding: 'crlf' });
    expect(documentPreviewKind('/x.csv', doc.text)).toBe('code');
    // …and is written back as is.
    expect(encodeForDisk('/x.csv', doc.text, doc.lineEnding, raw)).toBe(raw);
  });

  it('counts records, not lines: quoted newlines and trailing blank lines are not rows', () => {
    const lines = ['id,note'];
    for (let i = 0; i < CSV_TABLE_MAX_ROWS; i++) lines.push(`${i},"two\nlines"`);
    const raw = lines.join('\n') + '\n\n\n';
    expect(documentPreviewKind('/x.csv', decodeFromDisk('/x.csv', raw, 'lf').text)).toBe('csv');
  });
});

describe('a table buffer above the cap', () => {
  /** A table buffer with `dataRows` data rows. */
  const tableWith = (dataRows: number) =>
    rowsToTable([['id', 'name'], ...Array.from({ length: dataRows }, (_, i) => [String(i), `n ${i}`])]);

  it('is shown as plain text: the table code would draw every row', () => {
    expect(documentPreviewKind('/x.csv', tableWith(CSV_TABLE_MAX_ROWS))).toBe('csv');
    expect(documentPreviewKind('/x.csv', tableWith(CSV_TABLE_MAX_ROWS + 1))).toBe('code');
    expect(documentPreviewKind('/x.csv', tableWith(CSV_TABLE_MAX_ROWS) + '\n\n')).toBe('csv');
  });

  it('a .csv whose content is itself a pipe table over the cap opens as read-only text', () => {
    // Its raw fallback text IS a table — without the size check it would be
    // drawn whole, the hang the cap exists to prevent.
    const raw = tableWith(CSV_TABLE_MAX_ROWS + 1);
    const doc = decodeFromDisk('/x.csv', raw, 'lf');
    expect(doc.text).toBe(raw);
    expect(documentPreviewKind('/x.csv', doc.text)).toBe('code');
    expect(csvTableRefusal('/x.csv', doc.text)?.reason).toBe('too-large');
    expect(csvOpensReadOnly(csvTableRefusal('/x.csv', doc.text))).toBe(true);
  });
});

describe('csvOpensReadOnly', () => {
  it('only a CSV refused as too large is read-only; an unparseable one stays editable', () => {
    expect(csvOpensReadOnly({ reason: 'too-large', rows: CSV_TABLE_MAX_ROWS + 1 })).toBe(true);
    expect(csvOpensReadOnly({ reason: 'unparseable' })).toBe(false);
    expect(csvOpensReadOnly(null)).toBe(false);
  });
});

describe('csvTableRefusal', () => {
  it('a too-large CSV buffer: the reason and its data-row count', () => {
    const text = decodeFromDisk('/x.csv', csvWith(CSV_TABLE_MAX_ROWS + 5), 'lf').text;
    expect(csvTableRefusal('/x.csv', text)).toEqual({ reason: 'too-large', rows: CSV_TABLE_MAX_ROWS + 5 });
  });

  it('a CSV buffer that does not parse', () => {
    expect(csvTableRefusal('/x.csv', 'a,"open\n')).toEqual({ reason: 'unparseable' });
  });

  it('agrees with decodeFromDisk on the raw bytes, CRLF and BOM included', () => {
    const raw = '﻿' + csvWith(CSV_TABLE_MAX_ROWS + 1, '\r\n');
    const text = decodeFromDisk('/x.csv', raw, 'lf').text;
    expect(csvTableRefusal('/x.csv', text)).toEqual({ reason: 'too-large', rows: CSV_TABLE_MAX_ROWS + 1 });
  });

  it.each([
    ['a table buffer', '/x.csv', TABLE],
    ['a non-CSV path', '/x.md', 'a,"open\n'],
    ['an untitled document', null, 'a,"open\n'],
    ['plain text that would read as a table now', '/x.csv', 'a,b\n1,2\n'],
  ] as const)('null for %s', (_name, path, text) => {
    expect(csvTableRefusal(path, text)).toBeNull();
  });
});
