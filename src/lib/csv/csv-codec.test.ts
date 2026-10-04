import { describe, it, expect } from 'vitest';
import {
  isTableBuffer,
  decodeFromDisk,
  encodeForDisk,
  documentPreviewKind,
  newFileText,
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
