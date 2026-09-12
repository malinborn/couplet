import { describe, it, expect } from 'vitest';
import { cellSpans, sourceRangeForVisible, visibleLength } from './cell-anchor';
import { parseInlineMarkdown } from '../preview/tables';

/**
 * The pure half of the table-cell comment anchor (#42). What it proves is the
 * mapping: rendered offsets in, source offsets out, with formatted spans taken
 * whole. What it cannot prove is that Chrome reports the rendered offsets this
 * code is handed — that was measured in a browser (see the PR for #42).
 *
 * Helper: quote what a selection of `visible` inside `source` would anchor to.
 */
function quote(source: string, visible: string, occurrence = 0): string | null {
  const rendered = renderedText(source);
  let at = -1;
  for (let i = 0; i <= occurrence; i++) at = rendered.indexOf(visible, at + 1);
  if (at < 0) throw new Error(`"${visible}" is not in rendered text "${rendered}"`);
  const range = sourceRangeForVisible(source, at, at + visible.length);
  return range ? source.slice(range.from, range.to) : null;
}

/** What a cell shows on screen — the same join `renderCellContent` performs. */
function renderedText(source: string): string {
  return parseInlineMarkdown(source)
    .map((token) => (token.type === 'link' ? token.text : token.value))
    .join('');
}

describe('cellSpans', () => {
  it('tiles plain text as one span', () => {
    expect(cellSpans('soft yellow fruit')).toEqual([
      { visFrom: 0, visTo: 17, srcFrom: 0, srcTo: 17, atomic: false },
    ]);
  });

  it('accounts for bold markers in the source but not on screen', () => {
    expect(cellSpans('crisp **and** sweet')).toEqual([
      { visFrom: 0, visTo: 6, srcFrom: 0, srcTo: 6, atomic: false },
      { visFrom: 6, visTo: 9, srcFrom: 6, srcTo: 13, atomic: true },
      { visFrom: 9, visTo: 15, srcFrom: 13, srcTo: 19, atomic: false },
    ]);
  });

  it('measures a code span by the fence it opened with', () => {
    const spans = cellSpans('use ``a|b`` here');
    expect(spans).not.toBeNull();
    expect(spans?.[1]).toEqual({ visFrom: 4, visTo: 7, srcFrom: 4, srcTo: 11, atomic: true });
  });

  it('counts a link URL as markers', () => {
    expect(cellSpans('[docs](https://x.test)')).toEqual([
      { visFrom: 0, visTo: 4, srcFrom: 0, srcTo: 22, atomic: true },
    ]);
  });

  it('covers the whole source', () => {
    for (const text of [
      'plain',
      '**b** *i* ~~s~~ `c`',
      '***both*** and [a](b) tail',
      '',
    ]) {
      const spans = cellSpans(text);
      expect(spans, text).not.toBeNull();
      expect(spans && spans.length > 0 ? spans[spans.length - 1].srcTo : 0).toBe(text.length);
    }
  });

  it('reports the rendered width', () => {
    expect(visibleLength(cellSpans('crisp **and** sweet') ?? [])).toBe(15);
    expect(visibleLength([])).toBe(0);
  });
});

describe('sourceRangeForVisible', () => {
  it('maps a selection in plain text one-to-one', () => {
    expect(sourceRangeForVisible('soft yellow fruit', 5, 11)).toEqual({ from: 5, to: 11 });
  });

  it('shifts by the markers of everything before it', () => {
    // Rendered "crisp and sweet"; selecting "sweet" is source offsets 14..19.
    expect(quote('crisp **and** sweet', 'sweet')).toBe('sweet');
  });

  it('takes a formatted span whole when the selection clips it', () => {
    // Rendered "crisp and sweet"; dragging over "an" must not produce "**an".
    expect(quote('crisp **and** sweet', 'an')).toBe('**and**');
  });

  it('keeps the markers of a span the selection crosses out of', () => {
    expect(quote('crisp **and** sweet', 'and sw')).toBe('**and** sw');
  });

  it('spans several tokens', () => {
    expect(quote('**a** plain *b*', 'a plain b')).toBe('**a** plain *b*');
  });

  it('anchors a link to its whole source', () => {
    expect(quote('see [docs](https://x.test) now', 'doc')).toBe('[docs](https://x.test)');
  });

  it('returns null for an empty or reversed range', () => {
    expect(sourceRangeForVisible('abc', 2, 2)).toBeNull();
    expect(sourceRangeForVisible('abc', 2, 1)).toBeNull();
  });

  it('returns null when the range runs past the rendered text', () => {
    expect(sourceRangeForVisible('crisp **and** sweet', 0, 99)).toBeNull();
  });
});
