import { describe, it, expect } from 'vitest';
import {
  cellSpans,
  sourceRangeForVisible,
  visibleLength,
  visibleRangeForSource,
} from './cell-anchor';
import { parseInlineMarkdown } from '../preview/inline-tokens';

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

describe('visibleRangeForSource', () => {
  /** The rendered characters a stored anchor would highlight. */
  function shown(cell: string, source: string): string | null {
    const at = cell.indexOf(source);
    const range = visibleRangeForSource(cell, at, at + source.length);
    if (!range) return null;
    // The text the cell puts on screen, built the way `renderCellContent`
    // builds it, so the offsets can be read against something real.
    const visible = parseInlineMarkdown(cell)
      .map((token) => (token.type === 'link' ? token.text : token.value))
      .join('');
    return visible.slice(range.from, range.to);
  }

  it('maps an anchor in plain text one-to-one', () => {
    expect(visibleRangeForSource('soft yellow fruit', 5, 11)).toEqual({ from: 5, to: 11 });
  });

  it('subtracts the markers of everything before it', () => {
    // `sweet` sits at source 14 and at rendered 10 — the four asterisks of
    // `**and**` are not on screen.
    expect(visibleRangeForSource('crisp **and** sweet', 14, 19)).toEqual({ from: 10, to: 15 });
    expect(shown('crisp **and** sweet', 'sweet')).toBe('sweet');
  });

  it('shows the whole word for an anchor that stored the markers', () => {
    // This is what a comment on bold cell text actually stores (#42): the
    // quote is `**and**`, and the reader has to see "and" marked.
    expect(shown('crisp **and** sweet', '**and**')).toBe('and');
  });

  it('shows the whole word for an anchor that caught only a marker', () => {
    // Nothing else would be honest: half a marker pair renders as no
    // characters at all, and no highlight reads as "the comment is not here".
    expect(shown('crisp **and** sweet', '**')).toBe('and');
  });

  it('shows a link by its text, never by its URL', () => {
    expect(shown('see [docs](https://x.test) now', '[docs](https://x.test)')).toBe('docs');
    expect(shown('see [docs](https://x.test) now', 'https://x.test')).toBe('docs');
  });

  it('spans several tokens', () => {
    expect(shown('**a** plain *b*', '**a** plain *b*')).toBe('a plain b');
  });

  it('is the inverse of sourceRangeForVisible on plain runs', () => {
    const cell = 'crisp **and** sweet';
    const source = sourceRangeForVisible(cell, 10, 15);
    expect(source).toEqual({ from: 14, to: 19 });
    expect(visibleRangeForSource(cell, source!.from, source!.to)).toEqual({ from: 10, to: 15 });
  });

  it('returns null for an empty or reversed range', () => {
    expect(visibleRangeForSource('abc', 2, 2)).toBeNull();
    expect(visibleRangeForSource('abc', 2, 1)).toBeNull();
  });
});
