import { describe, it, expect } from 'vitest';
import { extOf, isCsvPath } from './csv-path';

describe('isCsvPath', () => {
  it.each([
    ['/a/b.csv', true],
    ['/a/b.TSV', true],
    ['/a/b.md', false],
    ['/a/csv', false],
    ['/a/.csv', false],
    ['/a.csv/b', false],
    [null, false],
    [undefined, false],
  ])('%s → %s', (path, expected) => {
    expect(isCsvPath(path)).toBe(expected);
  });
});

describe('extOf', () => {
  it.each([
    ['/a/b.TSV', 'tsv'],
    ['/a/b.tar.csv', 'csv'],
    ['/a/.csv', ''],
    ['/a/noext', ''],
  ])('%s → %j', (path, expected) => {
    expect(extOf(path)).toBe(expected);
  });
});
