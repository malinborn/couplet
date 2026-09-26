import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import { markupPairs, type MarkupPair } from './atomic';
import { repairChange, repairChangeSet, type PlainChange } from './markup-repair';

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, Table] }),
    ],
  });
}

function pairsOf(doc: string): MarkupPair[] {
  return markupPairs(makeState(doc));
}

/**
 * Apply a change through the repair layer and return the resulting document —
 * the only assertion that matters here is the source string, since that is what
 * is written to disk and what the user discovers is broken.
 */
function applyRepaired(doc: string, change: PlainChange): string {
  const state = makeState(doc);
  const fixed = repairChange(markupPairs(state), change) ?? change;
  return state.update({ changes: fixed }).state.doc.toString();
}

const DOC = 'Абзац с **жирным** словом.';
// Offsets: `**` 8..10, `жирным` 10..16, `**` 16..18.

describe('markupPairs', () => {
  it('describes a bold span as three adjacent regions', () => {
    const [pair] = pairsOf(DOC);
    expect(pair).toMatchObject({
      kind: 'strong',
      openFrom: 8,
      openTo: 10,
      contentFrom: 10,
      contentTo: 16,
      closeFrom: 16,
      closeTo: 18,
      openText: '**',
      closeText: '**',
    });
  });

  it("takes a link's closing region as the whole `](url)`, matching what decorateLink hides", () => {
    const [pair] = pairsOf('см. [текст](https://x.dev) далее');
    expect(pair.kind).toBe('link');
    expect(pair.openText).toBe('[');
    expect(pair.closeText).toBe('](https://x.dev)');
  });

  it('reports nested spans, outermost first', () => {
    const pairs = pairsOf('***оба***');
    expect(pairs.map((p) => p.kind)).toEqual(['emphasis', 'strong']);
  });

  it('has no pair for a checkbox look-alike link, matching the hidden-span exclusion', () => {
    expect(pairsOf('- [x](url) text')).toEqual([]);
  });
});

describe('repairChange — a torn pair', () => {
  it('deleting only the closing marker writes it back after the surviving content', () => {
    // What `skipAtomic` produces for a Backspace just past the closing `**`.
    expect(applyRepaired(DOC, { from: 16, to: 18, insert: '' })).toBe(DOC);
  });

  it('replacing a selection that crosses the closing marker re-closes the span', () => {
    // Spec §3.4: selection 13..20, typing "Ю".
    expect(applyRepaired(DOC, { from: 13, to: 20, insert: 'Ю' })).toBe('Абзац с **жир**Юловом.');
  });

  it('replacing a selection that crosses the opening marker re-opens the span', () => {
    expect(applyRepaired(DOC, { from: 5, to: 13, insert: '' })).toBe('Абзац**ным** словом.');
  });

  it('inserted text lands outside the repaired span, not inside it', () => {
    const out = applyRepaired(DOC, { from: 14, to: 19, insert: 'XY' });
    expect(out).toBe('Абзац с **жирн**XYсловом.');
  });

  it('a selection crossing two different spans repairs both', () => {
    expect(applyRepaired('a **bold** and *ital* z', { from: 5, to: 18, insert: 'Q' })).toBe(
      'a **b**Q*al* z'
    );
  });
});

describe('repairChange — inside a blockquote', () => {
  const QUOTED = '> **bold** x';
  // Offsets: `> ` 0..2, `**` 2..4, `bold` 4..8, `**` 8..10.

  it('reports the pairs of quoted text, nested quotes included', () => {
    expect(pairsOf(QUOTED)).toMatchObject([{ kind: 'strong', openFrom: 2, closeTo: 10 }]);
    expect(pairsOf('> > **b**')).toMatchObject([{ kind: 'strong', openFrom: 4, closeTo: 9 }]);
  });

  it('writes back a closing marker that a Backspace tore off', () => {
    expect(applyRepaired(QUOTED, { from: 8, to: 10, insert: '' })).toBe(QUOTED);
  });

  it('re-closes the span when a selection crosses the closing marker', () => {
    expect(applyRepaired(QUOTED, { from: 6, to: 11, insert: 'Q' })).toBe('> **bo**Qx');
  });
});

describe('repairChange — a pair that should die whole', () => {
  it('leaves a deletion of the entire span alone', () => {
    // Both markers are touched: the user is removing the span, not tearing it.
    // This is the case a naive "markers may not be deleted" rule would block.
    expect(applyRepaired(DOC, { from: 8, to: 18, insert: '' })).toBe('Абзац с  словом.');
  });

  it('leaves a whole-document replacement alone', () => {
    expect(applyRepaired(DOC, { from: 0, to: DOC.length, insert: 'x' })).toBe('x');
  });

  it('removes the markers when the last content character goes', () => {
    // The ordinary-deletion path: no marker anywhere near the change, but the
    // content is emptied, and `****` would then be literal visible text.
    expect(applyRepaired('Абзац с **ж** словом.', { from: 10, to: 11, insert: '' })).toBe(
      'Абзац с  словом.'
    );
  });

  it('cascades outward through nested spans', () => {
    expect(applyRepaired('Текст ***о*** дальше.', { from: 9, to: 10, insert: '' })).toBe(
      'Текст  дальше.'
    );
  });

  it('keeps the pair when the content is replaced rather than removed', () => {
    expect(applyRepaired(DOC, { from: 10, to: 16, insert: 'НОВОЕ' })).toBe(
      'Абзац с **НОВОЕ** словом.'
    );
  });
});

describe('repairChange — a line break inside a span', () => {
  it('closes the span before the break and reopens it after', () => {
    expect(applyRepaired(DOC, { from: 13, to: 13, insert: '\n' })).toBe(
      'Абзац с **жир**\n**ным** словом.'
    );
  });

  it('moves a break at the content end outside the span instead of emptying it', () => {
    expect(applyRepaired(DOC, { from: 16, to: 16, insert: '\n' })).toBe(
      'Абзац с **жирным**\n словом.'
    );
  });

  it('moves a break at the content start outside the span', () => {
    expect(applyRepaired(DOC, { from: 10, to: 10, insert: '\n' })).toBe(
      'Абзац с \n**жирным** словом.'
    );
  });

  it('splits around multi-line pasted text', () => {
    expect(applyRepaired(DOC, { from: 13, to: 13, insert: 'АА\nББ' })).toBe(
      'Абзац с **жир**АА\nББ**ным** словом.'
    );
  });

  it('splits a link by repeating its target, so both halves stay links', () => {
    expect(applyRepaired('[текст](u)', { from: 3, to: 3, insert: '\n' })).toBe('[те](u)\n[кст](u)');
  });

  it('leaves a break outside every span alone', () => {
    expect(repairChange(pairsOf(DOC), { from: 18, to: 18, insert: '\n' })).toBeNull();
  });
});

describe('repairChange — declines to act', () => {
  it('ignores a plain insertion, which is where the caret decides, not this layer', () => {
    expect(repairChange(pairsOf(DOC), { from: 18, to: 18, insert: 'Ж' })).toBeNull();
  });

  it('ignores a deletion wholly inside the content', () => {
    expect(repairChange(pairsOf(DOC), { from: 12, to: 13, insert: '' })).toBeNull();
  });

  it('ignores a deletion nowhere near a span', () => {
    expect(repairChange(pairsOf(DOC), { from: 0, to: 3, insert: '' })).toBeNull();
  });

  it('has nothing to do in a document with no pairs', () => {
    expect(repairChange(pairsOf('просто текст'), { from: 2, to: 5, insert: '' })).toBeNull();
  });
});

describe('repairChangeSet', () => {
  it('returns null when no change in the set needs repairing', () => {
    const state = makeState(DOC);
    const changes = state.changes({ from: 12, to: 13, insert: '' });
    expect(repairChangeSet(markupPairs(state), changes)).toBeNull();
  });

  it('repairs the torn change and passes the innocent one through', () => {
    const doc = '**a** plain **b**';
    const state = makeState(doc);
    // Two cursors: one tears `**b**`'s closing marker, one deletes plain text.
    const changes = state.changes([
      { from: 6, to: 7, insert: '' },
      { from: 15, to: 17, insert: '' },
    ]);
    const repaired = repairChangeSet(markupPairs(state), changes);
    expect(repaired).not.toBeNull();
    const result = state.update({ changes: state.changes(repaired!) }).state.doc.toString();
    expect(result).toBe('**a** lain **b**');
  });
});

describe('the two deletion cases are told apart by the shape of the change', () => {
  // §5.1 of the spec: the layer must distinguish "a marker was deleted because
  // skipAtomic widened the range" from "the user deleted the whole bold span".
  // Neither the user event nor the key is consulted — only which markers the
  // change touches, which is why it works for paste and drag-and-drop too.
  const pairs = pairsOf(DOC);

  it('one marker touched → torn → repaired', () => {
    expect(repairChange(pairs, { from: 16, to: 18, insert: '' })).not.toBeNull();
    expect(repairChange(pairs, { from: 8, to: 10, insert: '' })).not.toBeNull();
  });

  it('both markers touched → intentional → untouched', () => {
    expect(repairChange(pairs, { from: 8, to: 18, insert: '' })).toBeNull();
    expect(repairChange(pairs, { from: 7, to: 19, insert: '' })).toBeNull();
  });
});

describe('selection after a repair', () => {
  it('lands after the text the user inserted, not inside the restored marker', () => {
    const state = makeState(DOC).update({ selection: EditorSelection.range(13, 20) }).state;
    const change: PlainChange = { from: 13, to: 20, insert: 'Ю' };
    const fixed = repairChange(markupPairs(state), change)!;
    const after = state.update({ changes: fixed }).state;
    expect(after.doc.toString()).toBe('Абзац с **жир**Юловом.');
    // `**жир**` ends at 15, `Ю` occupies 15..16.
    expect(after.selection.main.head).toBe(16);
  });
});
