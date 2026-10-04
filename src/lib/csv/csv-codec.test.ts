import { describe, it, expect, beforeEach } from 'vitest';
import {
  isCsvPath,
  isCsvDocument,
  decodeFromDisk,
  encodeForDisk,
  codecRoundTrip,
  resetCsvCodec,
} from './csv-codec';
import { resolveExternalChange } from '../external-change';

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

  it('an empty file decodes to a table and saves back as empty', () => {
    const doc = decodeFromDisk('/empty.csv', '', 'lf');
    expect(isCsvDocument('/empty.csv')).toBe(true);
    expect(doc.text.startsWith('|')).toBe(true);
    expect(encodeForDisk('/empty.csv', doc.text, doc.lineEnding)).toBe('');
  });
});

describe('codecRoundTrip', () => {
  it('is identity for non-CSV paths', () => {
    expect(codecRoundTrip('/x.md', '| a |\n|-|\n')).toBe('| a |\n|-|\n');
  });

  it('is identity for a CSV path that did not parse', () => {
    decodeFromDisk('/x.csv', 'a,"open\n', 'lf');
    expect(codecRoundTrip('/x.csv', 'a,"open\n')).toBe('a,"open\n');
  });

  it('equals what the next read of the saved file returns', () => {
    const doc = decodeFromDisk('/x.csv', 'a,b\n1,2\n', 'lf');
    const edited = doc.text.replace('| 2 |', '|xyz|'); // non-canonical, as a cell commit leaves it
    const written = encodeForDisk('/x.csv', edited, 'lf');
    const echo = decodeFromDisk('/x.csv', written, 'lf').text;
    expect(codecRoundTrip('/x.csv', edited)).toBe(echo);
    expect(echo).not.toBe(edited);
  });

  it('makes the echo of our own save resolve to ignore — the raw buffer as baseline would not', () => {
    const doc = decodeFromDisk('/x.csv', 'a,b\n1,2\n', 'lf');
    const buffer = doc.text.replace('| 2 |', '|xyz|'); // non-canonical, as a cell commit leaves it
    const baseline = codecRoundTrip('/x.csv', buffer); // what a save stores
    const written = encodeForDisk('/x.csv', buffer, 'lf');
    const disk = decodeFromDisk('/x.csv', written, 'lf').text; // the watcher re-reads the file

    expect(resolveExternalChange({ disk, buffer, baseline, dismissedDisk: null })).toBe('ignore');
    // With the buffer itself as the baseline the echo is taken for an external
    // change: the buffer "never diverged", so it would be silently reloaded.
    expect(
      resolveExternalChange({ disk, buffer, baseline: buffer, dismissedDisk: null })
    ).not.toBe('ignore');
  });
});
