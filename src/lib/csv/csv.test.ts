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
    const r = ok('\uFEFFa,b\r\n1,2\r\n');
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
    expect(serializeCsv([['a', 'b'], ['1', '2;3']], d)).toBe('\uFEFFa;b\r\n1;"2;3"');
  });

  it('serializes zero rows as an empty file', () => {
    expect(serializeCsv([], lf)).toBe('');
  });

  it.each([
    'a,b\n1,2\n',
    'a;b\r\n"x;y";2\r\n',
    '\uFEFFname,note\n"a ""q""","l1\nl2"\n',
    'a,b\n,\nx,\n',
    'a\tb\n1\t2',
  ])('round-trips canonical input %j', (text) => {
    const r = ok(text);
    expect(serializeCsv(r.rows, r.dialect)).toBe(text);
  });
});
