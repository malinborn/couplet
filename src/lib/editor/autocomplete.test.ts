import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
  computeOrderedListRenumberChanges,
  computeListIndentChanges,
  indentStepFor,
  outdentStepFor,
  selectedLineNumbers,
} from './autocomplete.js';

function applyRenumber(initial: string, anchorLineNumber: number): string {
  const state = EditorState.create({ doc: initial });
  const changes = computeOrderedListRenumberChanges(state.doc, anchorLineNumber);
  return state.update({ changes }).newDoc.toString();
}

describe('computeOrderedListRenumberChanges', () => {
  it('keeps already-correct numbering untouched', () => {
    const doc = ['1. A', '2. B', '3. C'].join('\n');
    expect(applyRenumber(doc, 1)).toBe(doc);
  });

  it('resets a newly indented item to 1 and renumbers parent items below', () => {
    // user pressed Tab on the second item (was "2. B" at parent level → now "   2. B" at child level)
    const doc = ['1. A', '   2. B', '3. C', '4. D'].join('\n');
    expect(applyRenumber(doc, 2)).toBe(
      ['1. A', '   1. B', '2. C', '3. D'].join('\n')
    );
  });

  it('user scenario: numbered list with continued counter after indent', () => {
    // After Enter on "2. ..." autocomplete inserts "3. ", then Tab indents it.
    // Before renumber: "   3. " — should become "   1. ".
    const doc = ['1. A', '2. B', '   3. '].join('\n');
    expect(applyRenumber(doc, 3)).toBe(
      ['1. A', '2. B', '   1. '].join('\n')
    );
  });

  it('renumbers parent list when an item is outdented (Shift-Tab)', () => {
    // user pressed Shift-Tab on the second sub-item — it moved up to parent level
    const doc = ['1. A', '   1. AA', '2. AB', '3. C'].join('\n');
    expect(applyRenumber(doc, 3)).toBe(
      ['1. A', '   1. AA', '2. AB', '3. C'].join('\n')
    );
  });

  it('continues numbering at deeper level when previous sibling exists at that level', () => {
    const doc = ['1. A', '   1. AA', '   3. AB'].join('\n');
    expect(applyRenumber(doc, 3)).toBe(
      ['1. A', '   1. AA', '   2. AB'].join('\n')
    );
  });

  it('resets deeper counters when returning to a shallower level', () => {
    const doc = [
      '1. A',
      '   1. AA',
      '   2. AB',
      '2. B',
      '   5. BA',
      '   9. BB',
    ].join('\n');
    expect(applyRenumber(doc, 1)).toBe(
      [
        '1. A',
        '   1. AA',
        '   2. AB',
        '2. B',
        '   1. BA',
        '   2. BB',
      ].join('\n')
    );
  });

  it('does not cross a blank line', () => {
    const doc = ['1. A', '2. B', '', '5. X', '6. Y'].join('\n');
    // anchor on first block — only that block renumbers; second block untouched
    expect(applyRenumber(doc, 1)).toBe(doc);
  });

  it('handles mixed bullets and ordered items at the same level', () => {
    const doc = ['- A', '- B', '1. C', '5. D'].join('\n');
    expect(applyRenumber(doc, 3)).toBe(
      ['- A', '- B', '1. C', '2. D'].join('\n')
    );
  });

  it('handles a single ordered item without changes', () => {
    expect(applyRenumber('1. A', 1)).toBe('1. A');
  });

  it('renumbers a deeply nested list (3+ levels)', () => {
    const doc = [
      '1. a',
      '  1. b',
      '    5. c',
      '    9. d',
      '      2. e',
      '      4. f',
    ].join('\n');
    expect(applyRenumber(doc, 3)).toBe(
      [
        '1. a',
        '  1. b',
        '    1. c',
        '    2. d',
        '      1. e',
        '      2. f',
      ].join('\n')
    );
  });

  it('produces no changes for non-list lines around the anchor', () => {
    const state = EditorState.create({ doc: 'just text\nno list here' });
    const changes = computeOrderedListRenumberChanges(state.doc, 1);
    expect(changes).toEqual([]);
  });
});

describe('computeListIndentChanges', () => {
  function apply(
    initial: string,
    range: { from: number; to: number },
    indent: boolean
  ): string | null {
    const state = EditorState.create({ doc: initial });
    const changes = computeListIndentChanges(state.doc, [range], indent);
    if (changes === null) return null;
    return state.update({ changes }).newDoc.toString();
  }

  /** A range running from inside `fromLine` to inside `toLine`. */
  function spanLines(doc: string, fromLine: number, toLine: number) {
    const state = EditorState.create({ doc });
    return {
      from: state.doc.line(fromLine).from + 3,
      to: state.doc.line(toLine).from + 3,
    };
  }

  it('indents every selected item, not just the first', () => {
    const doc = ['- alpha', '- bravo', '- charlie', '- delta'].join('\n');
    expect(apply(doc, spanLines(doc, 2, 4), true)).toBe(
      ['- alpha', '  - bravo', '  - charlie', '  - delta'].join('\n')
    );
  });

  it('outdents every selected item', () => {
    const doc = ['- alpha', '  - bravo', '  - charlie'].join('\n');
    expect(apply(doc, spanLines(doc, 2, 3), false)).toBe(
      ['- alpha', '- bravo', '- charlie'].join('\n')
    );
  });

  it('claims the key but changes nothing when every item is already flush left', () => {
    const doc = ['- alpha', '- bravo'].join('\n');
    const state = EditorState.create({ doc });
    expect(
      computeListIndentChanges(state.doc, [spanLines(doc, 1, 2)], false)
    ).toEqual([]);
  });

  it('outdents only the items that have room, in a mixed selection', () => {
    const doc = ['- alpha', '  - bravo', '- charlie'].join('\n');
    expect(apply(doc, spanLines(doc, 1, 3), false)).toBe(
      ['- alpha', '- bravo', '- charlie'].join('\n')
    );
  });

  it('skips non-list lines inside the selection', () => {
    const doc = ['- alpha', '  continuation', '- bravo', '', 'plain paragraph'].join('\n');
    const state = EditorState.create({ doc });
    expect(apply(doc, { from: 0, to: state.doc.length }, true)).toBe(
      ['  - alpha', '  continuation', '  - bravo', '', 'plain paragraph'].join('\n')
    );
  });

  it('returns null when the selection holds no list line at all', () => {
    const doc = ['plain one', 'plain two'].join('\n');
    const state = EditorState.create({ doc });
    expect(
      computeListIndentChanges(state.doc, [{ from: 0, to: state.doc.length }], true)
    ).toBeNull();
  });

  it('handles a bare cursor exactly as before', () => {
    const doc = ['- alpha', '- bravo'].join('\n');
    const state = EditorState.create({ doc });
    const at = state.doc.line(2).from + 3;
    expect(apply(doc, { from: at, to: at }, true)).toBe(['- alpha', '  - bravo'].join('\n'));
  });

  // #44: two spaces do not reach an ordered item's content column, so the
  // sub-item parsed as a sibling and rendered at its parent's indent.
  it('indents an ordered item to its parent\'s content column', () => {
    const doc = ['1. one', '2. two', '3. three'].join('\n');
    expect(apply(doc, spanLines(doc, 2, 3), true)).toBe(
      ['1. one', '   2. two', '   3. three'].join('\n')
    );
  });

  it('reaches past a two-digit parent marker', () => {
    const doc = ['9. nine', '10. ten', '11. eleven'].join('\n');
    expect(apply(doc, spanLines(doc, 3, 3), true)).toBe(
      ['9. nine', '10. ten', '    11. eleven'].join('\n')
    );
  });

  it('moves a whole nested block by one step, keeping its shape', () => {
    const doc = ['1. one', '2. two', '   1. inner'].join('\n');
    expect(apply(doc, spanLines(doc, 2, 3), true)).toBe(
      ['1. one', '   2. two', '      1. inner'].join('\n')
    );
  });

  it('outdents an ordered item back onto its parent column', () => {
    const doc = ['1. one', '   1. inner', '   2. inner two'].join('\n');
    expect(apply(doc, spanLines(doc, 2, 3), false)).toBe(
      ['1. one', '1. inner', '2. inner two'].join('\n')
    );
  });

  it('indents under a bullet parent by two, as before', () => {
    const doc = ['- alpha', '- bravo'].join('\n');
    expect(apply(doc, spanLines(doc, 2, 2), true)).toBe(
      ['- alpha', '  - bravo'].join('\n')
    );
  });

  it('indents a mixed nesting to whichever parent it sits under', () => {
    const doc = ['1. one', '   - bullet', '   - bullet two'].join('\n');
    expect(apply(doc, spanLines(doc, 3, 3), true)).toBe(
      ['1. one', '   - bullet', '     - bullet two'].join('\n')
    );
  });
});

describe('indentStepFor / outdentStepFor', () => {
  const at = (lines: string[], ln: number) => {
    const { doc } = EditorState.create({ doc: lines.join('\n') });
    return { indent: indentStepFor(doc, ln), outdent: outdentStepFor(doc, ln) };
  };

  it('falls back to two spaces for the first item of a list', () => {
    expect(at(['1. one', '2. two'], 1).indent).toBe(2);
  });

  it('ignores a wrapped paragraph line when looking for the parent', () => {
    const doc = ['1. one', '   continued here', '2. two'];
    expect(at(doc, 3).indent).toBe(3);
  });

  it('stops at a blank line rather than nesting into the list above', () => {
    expect(at(['1. one', '', '- fresh list'], 3).indent).toBe(2);
  });

  it('reports no room to outdent a top-level item', () => {
    expect(at(['- alpha', '- bravo'], 2).outdent).toBe(0);
  });

  it('outdents to the parent column, not by a fixed unit', () => {
    expect(at(['10. ten', '    1. inner'], 2).outdent).toBe(4);
  });
});

describe('selectedLineNumbers', () => {
  it('excludes a trailing line the selection only just reaches', () => {
    const state = EditorState.create({ doc: ['a', 'b', 'c'].join('\n') });
    const range = { from: state.doc.line(1).from, to: state.doc.line(3).from };
    expect(selectedLineNumbers(state.doc, [range])).toEqual([1, 2]);
  });

  it('keeps a single line when the cursor sits at its start', () => {
    const state = EditorState.create({ doc: ['a', 'b'].join('\n') });
    const at = state.doc.line(2).from;
    expect(selectedLineNumbers(state.doc, [{ from: at, to: at }])).toEqual([2]);
  });

  it('merges overlapping ranges without repeating a line', () => {
    const { doc } = EditorState.create({ doc: ['a', 'b', 'c'].join('\n') });
    expect(
      selectedLineNumbers(doc, [
        { from: doc.line(1).from, to: doc.line(2).to },
        { from: doc.line(2).from, to: doc.line(3).to },
      ])
    ).toEqual([1, 2, 3]);
  });
});
