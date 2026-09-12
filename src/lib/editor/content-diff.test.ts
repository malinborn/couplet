import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
  computeReplacement,
  computeChangedLineRanges,
  BLOCK_REWRITE_THRESHOLD,
} from './content-diff';

/** Applies a Replacement through an actual CM6 transaction, so an invalid span throws like production. */
function applyViaCM6(oldText: string, repl: ReturnType<typeof computeReplacement>): string {
  if (!repl) return oldText;
  const state = EditorState.create({ doc: oldText });
  return state.update({ changes: repl }).state.doc.toString();
}

describe('computeReplacement', () => {
  it('IdenticalStrings_ReturnsNull', () => {
    expect(computeReplacement('hello world', 'hello world')).toBeNull();
  });

  it('AppendAtEnd_ReplacesOnlyTail', () => {
    const repl = computeReplacement('hello', 'hello world');
    expect(repl).toEqual({ from: 5, to: 5, insert: ' world' });
  });

  it('PrependAtStart_ReplacesOnlyHead', () => {
    const repl = computeReplacement('world', 'hello world');
    expect(repl).toEqual({ from: 0, to: 0, insert: 'hello ' });
  });

  it('InsertionInMiddle_ReplacesOnlyGap', () => {
    const repl = computeReplacement('ac', 'abc');
    expect(repl).toEqual({ from: 1, to: 1, insert: 'b' });
  });

  it('DeletionInMiddle_ReplacesOnlyGap', () => {
    const repl = computeReplacement('abc', 'ac');
    expect(repl).toEqual({ from: 1, to: 2, insert: '' });
  });

  it('FullyDissimilarStrings_ReplacesWholeDoc', () => {
    const repl = computeReplacement('foo', 'bar');
    expect(repl).toEqual({ from: 0, to: 3, insert: 'bar' });
  });

  it('EmptyToText_InsertsAtStart', () => {
    const repl = computeReplacement('', 'new content');
    expect(repl).toEqual({ from: 0, to: 0, insert: 'new content' });
  });

  it('TextToEmpty_DeletesWholeDoc', () => {
    const repl = computeReplacement('old content', '');
    expect(repl).toEqual({ from: 0, to: 11, insert: '' });
  });

  it('TrailingNewlineRemoved_ReplacesOnlyNewline', () => {
    const repl = computeReplacement('abc\n', 'abc');
    expect(repl).toEqual({ from: 3, to: 4, insert: '' });
  });

  it('OverlappingPrefixSuffix_ClampsToValidSpan', () => {
    // Naive prefix/suffix scans would count the shared 'a' twice (prefix=2, suffix=2
    // on length-2/3 strings) and produce an out-of-range span. Must clamp.
    const repl = computeReplacement('aa', 'aaa');
    expect(repl).not.toBeNull();
    expect(repl!.from).toBeLessThanOrEqual(repl!.to);
    expect(applyViaCM6('aa', repl)).toBe('aaa');
  });

  it('SurrogatePairEdit_RoundTripsExactly', () => {
    // 😀 (U+1F600) and 😃 (U+1F603) share the same high surrogate, so the
    // char-code prefix/suffix scan lands its boundary between the high and
    // low surrogate halves. The resulting span must still recombine correctly
    // when applied — anything else corrupts the character.
    const oldText = 'a😀b';
    const newText = 'a😃b';
    const repl = computeReplacement(oldText, newText);
    expect(applyViaCM6(oldText, repl)).toBe(newText);
  });

  it.each<[string, string, string]>([
    ['both empty', '', ''],
    ['single char unchanged', 'a', 'a'],
    ['single char append', 'a', 'aa'],
    ['single char delete', 'aa', 'a'],
    ['identical multi-char', 'aaa', 'aaa'],
    ['shrink repeated char', 'aaaa', 'aa'],
    ['middle substitution', 'abcdef', 'abXYdef'],
    ['markdown body edit', '# Title\n\nBody text.\n', '# Title\n\nBody text, edited.\n'],
    ['single word changed mid-document', 'line1\nline2\nline3', 'line1\nlineTWO\nline3'],
    ['delete everything', 'xyz', ''],
    ['insert into empty doc', '', 'xyz'],
  ])('RoundTrip_%s', (_label, oldText, newText) => {
    const repl = computeReplacement(oldText, newText);
    expect(applyViaCM6(oldText, repl)).toBe(newText);
  });
});

describe('computeReplacement + CM6 transaction', () => {
  it('AppendedText_SelectionHeadUnchanged', () => {
    const oldText = 'line1\nline2\nline3';
    const state = EditorState.create({
      doc: oldText,
      selection: { anchor: 8 }, // inside "line2"
    });

    const newText = oldText + '\nline4';
    const repl = computeReplacement(oldText, newText);
    expect(repl).not.toBeNull();

    const tr = state.update({ changes: repl! });
    expect(tr.state.doc.toString()).toBe(newText);
    // The edit is entirely after the selection, so CM6's automatic mapping
    // must leave the head exactly where it was.
    expect(tr.state.selection.main.head).toBe(8);
  });

  it('PrependedText_SelectionHeadShiftsByInsertionLength', () => {
    const oldText = 'line1\nline2\nline3';
    const state = EditorState.create({
      doc: oldText,
      selection: { anchor: 8 }, // inside "line2"
    });

    const newText = 'HEADER\n' + oldText;
    const repl = computeReplacement(oldText, newText);
    expect(repl).toEqual({ from: 0, to: 0, insert: 'HEADER\n' });

    const tr = state.update({ changes: repl! });
    expect(tr.state.doc.toString()).toBe(newText);
    // The insertion is entirely before the selection, so the head must shift
    // by exactly the inserted length (7 chars: "HEADER\n").
    expect(tr.state.selection.main.head).toBe(15);
  });

  it('CaretInsideReplacedSpan_CollapsesToChangeStart', () => {
    const oldText = 'aaa BBBB ccc';
    const state = EditorState.create({
      doc: oldText,
      selection: { anchor: 6 }, // inside the "BBBB" span that gets replaced
    });

    const newText = 'aaa XYZ ccc';
    const repl = computeReplacement(oldText, newText);
    expect(repl).toEqual({ from: 4, to: 8, insert: 'XYZ' });

    const tr = state.update({ changes: repl! });
    expect(tr.state.doc.toString()).toBe(newText);
    // A caret that lands inside a replaced span has no stable position to map
    // to — CM6's default mapping collapses it to the start of the change.
    expect(tr.state.selection.main.head).toBe(4);
  });
});

// --- computeChangedLineRanges ------------------------------------------------

const PARA = [
  'Runbook for the nightly export job.',
  'The job starts at 03:00 UTC and writes to the staging bucket.',
  'On failure it retries three times with exponential backoff.',
  'Alerts go to the #infra channel.',
  'Owner: platform team.',
].join('\n');

/**
 * Measured changed-line share of the block a case touches: the largest
 * threshold at which the case is still reported wholesale. Sweeping the real
 * function is deliberate — it measures shipped behaviour rather than a
 * re-implementation of the ratio.
 */
function measuredBlockRatio(oldText: string, newText: string): number {
  const wholesale = JSON.stringify(computeChangedLineRanges(oldText, newText, 0));
  let last = 0;
  for (let t = 1; t <= 100; t++) {
    if (JSON.stringify(computeChangedLineRanges(oldText, newText, t / 100)) !== wholesale) break;
    last = t / 100;
  }
  return last;
}

describe('computeChangedLineRanges', () => {
  it('IdenticalText_ReportsNothing', () => {
    expect(computeChangedLineRanges('a\nb\n', 'a\nb\n')).toEqual([]);
  });

  it('SingleWordChanged_ReportsOnlyThatLine', () => {
    const oldText = 'line one\nline two\nline three\nline four\nline five';
    const newText = 'line one\nline two\nline THREE\nline four\nline five';
    expect(computeChangedLineRanges(oldText, newText)).toEqual([[3, 3]]);
  });

  it('OneLineOfManyChanged_DoesNotSpillOntoNeighbours', () => {
    const newText = PARA.replace(
      'Alerts go to the #infra channel.',
      'Alerts are routed to #infra and page after two failures.'
    );
    expect(computeChangedLineRanges(PARA, newText)).toEqual([[4, 4]]);
  });

  it('TwoDistantEdits_ReportSeparateRanges_NotOneCoalescedSpan', () => {
    // Issue #27 in miniature: `computeReplacement` collapses these into a single
    // span covering lines 2..9, which is what used to wash the whole document.
    const oldLines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const newLines = [...oldLines];
    newLines[1] = 'B!';
    newLines[8] = 'I!';
    const oldText = oldLines.join('\n');
    const newText = newLines.join('\n');

    const repl = computeReplacement(oldText, newText)!;
    const spanLines = newText.slice(repl.from, repl.from + repl.insert.length).split('\n').length;
    expect(spanLines).toBeGreaterThan(2); // the coalesced span really does cover the middle

    expect(computeChangedLineRanges(oldText, newText)).toEqual([
      [2, 2],
      [9, 9],
    ]);
  });

  it('WholeBlockReplaced_ReportsTheWholeBlock', () => {
    const oldText = '# Title\n\nold one\nold two\nold three\n\n## Tail\n';
    const newText = '# Title\n\nnew alpha\nnew beta\nnew gamma\n\n## Tail\n';
    expect(computeChangedLineRanges(oldText, newText)).toEqual([[3, 5]]);
  });

  it('BlockInserted_ReportsTheWholeInsertedBlock', () => {
    const oldText = '# Doc\n\nintro\n';
    const newText = '# Doc\n\nintro\n\n## Added\n\nfresh one\nfresh two\n';
    // Lines 5..9 are all *new*, including the blank separators between them,
    // so they coalesce into one contiguous range. That is deliberate: an
    // inserted section reads as one thing, and the alternative (two ranges
    // with an unhighlighted gap) looks like two unrelated edits. Only blank
    // lines that already existed break a range apart — see
    // `BlankLineSeparatedEdits_StaySeparate`.
    expect(computeChangedLineRanges(oldText, newText)).toEqual([[5, 9]]);
  });

  it('BlockDeleted_ReportsNothingToHighlight', () => {
    const oldText = '# Doc\n\nkeep me\n\ndrop one\ndrop two\n';
    const newText = '# Doc\n\nkeep me\n';
    expect(computeChangedLineRanges(oldText, newText)).toEqual([]);
  });

  it('EveryLineRewritten_ReportsOneFullRange', () => {
    expect(computeChangedLineRanges('aaa\nbbb\nccc', 'xxx\nyyy\nzzz')).toEqual([[1, 3]]);
  });

  it('SingleLineBlock_IsAlwaysWholesale', () => {
    expect(computeChangedLineRanges('# Old\n\nbody\n', '# New\n\nbody\n')).toEqual([[1, 1]]);
  });

  it('BlankLineSeparatedEdits_StaySeparate', () => {
    const oldText = 'p1 a\np1 b\n\np2 a\np2 b\n';
    const newText = 'p1 A!\np1 b\n\np2 a\np2 B!\n';
    expect(computeChangedLineRanges(oldText, newText)).toEqual([
      [1, 1],
      [5, 5],
    ]);
  });

  it('ScatteredEditsInALongDoc_HighlightFarLessThanTheCoalescedSpan', () => {
    const oldLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[4] = 'line 5 edited';
    newLines[54] = 'line 55 edited';
    const oldText = oldLines.join('\n');
    const newText = newLines.join('\n');

    const ranges = computeChangedLineRanges(oldText, newText);
    const highlighted = ranges.reduce((n, [s, e]) => n + (e - s + 1), 0);
    // Every line is its own block here (no blank lines... actually one block of
    // 60 lines: 2/60 changed is far below threshold), so only the two edits light up.
    expect(ranges).toEqual([
      [5, 5],
      [55, 55],
    ]);
    expect(highlighted).toBe(2);
  });
});

describe('computeChangedLineRanges — threshold boundary', () => {
  // A 5-line block with exactly 3 changed lines: ratio 0.6, the threshold itself.
  const oldText = ['k1', 'x2', 'x3', 'x4', 'k5'].join('\n');
  const newText = ['k1', 'y2', 'y3', 'y4', 'k5'].join('\n');

  it('RatioExactlyAtThreshold_GoesWholesale', () => {
    expect(computeChangedLineRanges(oldText, newText, 0.6)).toEqual([[1, 5]]);
  });

  it('RatioJustBelowThreshold_StaysLineByLine', () => {
    // Same block, one fewer changed line: 2/5 = 0.4 < 0.6.
    const near = ['k1', 'y2', 'y3', 'x4', 'k5'].join('\n');
    expect(computeChangedLineRanges(oldText, near, 0.6)).toEqual([[2, 3]]);
  });

  it('ThresholdRaisedJustAboveTheRatio_FlipsToLineByLine', () => {
    expect(computeChangedLineRanges(oldText, newText, 0.61)).toEqual([[2, 4]]);
  });

  it('ThresholdLoweredJustBelowTheRatio_StaysWholesale', () => {
    expect(computeChangedLineRanges(oldText, newText, 0.59)).toEqual([[1, 5]]);
  });
});

describe('computeChangedLineRanges — threshold calibration', () => {
  /** Realistic point edits: an agent fixing or rewording part of a block. */
  const pointEdits: Array<[string, string, string]> = [
    ['typo fix in a 5-line paragraph', PARA, PARA.replace('backoff', 'back-off')],
    [
      'sentence reworded, 1 line of 5',
      PARA,
      PARA.replace('Owner: platform team.', 'Owner: the platform infrastructure team.'),
    ],
    [
      'two lines reworded out of 5',
      PARA,
      PARA.replace('03:00 UTC', '04:00 UTC').replace('#infra', '#infra-alerts'),
    ],
    [
      'one bullet of 6 edited',
      '- alpha\n- beta\n- gamma\n- delta\n- epsilon\n- zeta',
      '- alpha\n- beta\n- gamma revised\n- delta\n- epsilon\n- zeta',
    ],
    [
      'one table row of 5 edited',
      '| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |\n| c | 3 |',
      '| k | v |\n|---|---|\n| a | 1 |\n| b | 22 |\n| c | 3 |',
    ],
    [
      'worst case: 1 line of a 2-line paragraph',
      'First line stays.\nSecond line gets reworded.',
      'First line stays.\nSecond line now says something else.',
    ],
  ];

  /** Realistic wholesale rewrites: a block created or replaced outright. */
  const wholesaleEdits: Array<[string, string, string]> = [
    ['heading renamed (1-line block)', '# Old Title\n\nbody\n', '# New Title\n\nbody\n'],
    [
      'paragraph rewritten wholesale',
      'aaa one\nbbb two\nccc three\nddd four',
      'new sentence one\nnew sentence two\nnew sentence three\nnew sentence four',
    ],
    [
      'new paragraph inserted',
      '# Doc\n\nintro\n',
      '# Doc\n\nintro\n\nfresh line one\nfresh line two\n',
    ],
  ];

  it.each(pointEdits)('PointEdit_%s_MeasuresAtOrBelow0.5', (_label, oldText, newText) => {
    expect(measuredBlockRatio(oldText, newText)).toBeLessThanOrEqual(0.5);
  });

  it.each(wholesaleEdits)('Wholesale_%s_MeasuresAt1.0', (_label, oldText, newText) => {
    expect(measuredBlockRatio(oldText, newText)).toBe(1);
  });

  it('ChosenThresholdSitsInTheGapBetweenTheTwoPopulations', () => {
    const worstPoint = Math.max(...pointEdits.map(([, o, n]) => measuredBlockRatio(o, n)));
    const weakestWholesale = Math.min(...wholesaleEdits.map(([, o, n]) => measuredBlockRatio(o, n)));
    expect(worstPoint).toBeLessThan(BLOCK_REWRITE_THRESHOLD);
    expect(weakestWholesale).toBeGreaterThanOrEqual(BLOCK_REWRITE_THRESHOLD);
  });

  it('EveryPointEditStaysLineByLineAtTheChosenThreshold', () => {
    for (const [label, oldText, newText] of pointEdits) {
      const atThreshold = JSON.stringify(computeChangedLineRanges(oldText, newText));
      const wholeBlock = JSON.stringify(computeChangedLineRanges(oldText, newText, 0));
      expect(atThreshold, label).not.toBe(wholeBlock);
    }
  });
});
