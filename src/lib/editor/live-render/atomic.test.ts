import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { ensureSyntaxTree } from '@codemirror/language';
import { Strikethrough, Table } from '@lezer/markdown';
import { hiddenMarkRanges, liveRenderAtomic } from './atomic';

const markdownExt = markdown({
  base: markdownLanguage,
  codeLanguages: languages,
  extensions: [Strikethrough, Table],
});

/** EditorState with the syntax tree fully (synchronously) parsed. */
function makeState(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [markdownExt] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function spans(doc: string): Array<[number, number]> {
  const state = makeState(doc);
  const result: Array<[number, number]> = [];
  hiddenMarkRanges(state).between(0, doc.length, (from, to) => {
    result.push([from, to]);
  });
  return result;
}

describe('hiddenMarkRanges — one marker type at a time', () => {
  it('heading: hides HeaderMark plus one trailing space', () => {
    // "## Heading" — HeaderMark is [0,2); decorator hides through the
    // space at index 2 as well (headings.ts:32's `mark.to + 1`).
    expect(spans('## Heading\n')).toEqual([[0, 3]]);
  });

  it('emphasis: both EmphasisMark children, individually', () => {
    expect(spans('*a*\n')).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('strongEmphasis: both EmphasisMark children, individually', () => {
    expect(spans('**a**\n')).toEqual([
      [0, 2],
      [3, 5],
    ]);
  });

  it('strikethrough: both StrikethroughMark children, individually', () => {
    expect(spans('~~a~~\n')).toEqual([
      [0, 2],
      [3, 5],
    ]);
  });

  it('inlineCode: both CodeMark children, individually', () => {
    expect(spans('`a`\n')).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('link: opening `[` alone, then one combined span from `]` through the end', () => {
    // "[text](url)" — open `[` at [0,1); combined closing span covers
    // `](url)` including the URL text, not just the LinkMark characters.
    expect(spans('[text](url)\n')).toEqual([
      [0, 1],
      [5, 11],
    ]);
  });

  it('a bracket pair that is not a link hides nothing (#51)', () => {
    // `@lezer/markdown` emits a Link node for every `[` ... `]`. Nothing of
    // an unresolved shortcut reference is hidden, so nothing may be atomic —
    // atomic ranges over visible characters trap the caret in plain text.
    expect(spans('see [1] here\n')).toEqual([]);
    expect(spans('dict["k"]\n')).toEqual([]);
  });

  it('a shortcut reference WITH a definition is hidden as a link again', () => {
    // "[foo]" resolved by the definition below: `[` alone, then `]`.
    expect(spans('[foo]\n\n[foo]: /x\n')).toEqual([
      [0, 1],
      [4, 5],
    ]);
  });

  it('descends into a non-link bracket pair, so inner markers stay atomic', () => {
    // plugin.ts renders the bold inside `[**a** b]`; the atomic set has to
    // agree, or the caret could sit inside markers that are not on screen.
    expect(spans('[**a** b]\n')).toEqual([
      [1, 3],
      [4, 6],
    ]);
  });

  it('listBullet: the ListMark alone', () => {
    expect(spans('- a\n')).toEqual([[0, 1]]);
  });

  it('blockquote: leading `>` plus one optional trailing space', () => {
    expect(spans('> a\n')).toEqual([[0, 2]]);
  });

  it('ordered list markers are never hidden (out of v1 scope)', () => {
    expect(spans('1. a\n')).toEqual([]);
  });
});

describe('hiddenMarkRanges — nested and adjacent formatting', () => {
  it('adjacent StrongEmphasis + Emphasis are both hidden independently', () => {
    // "**a**_b_" — siblings, not nested: StrongEmphasis[0,5), Emphasis[5,8).
    expect(spans('**a**_b_\n')).toEqual([
      [0, 2],
      [3, 5],
      [5, 6],
      [7, 8],
    ]);
  });

  it('nested emphasis inside strong is hidden too', () => {
    // "**_both_**" — plugin.ts descends into inline nodes, so the inner
    // Emphasis is decorated as well and its markers must be atomic to match.
    // Leaving them out would let the caret walk into text that is not drawn.
    expect(spans('**_both_**\n')).toEqual([
      [0, 2],
      [2, 3],
      [7, 8],
      [8, 10],
    ]);
  });

  it('bold-italic written with three asterisks hides every marker', () => {
    // "***both***" is the combination users actually type. Lezer nests
    // StrongEmphasis inside Emphasis here; before the pass descended, the
    // inner `**` pair rendered as literal text next to italic content.
    expect(spans('***both***\n')).toEqual([
      [0, 1],
      [1, 3],
      [7, 9],
      [9, 10],
    ]);
  });

  it('bold inside strikethrough hides every marker', () => {
    expect(spans('~~**x**~~\n')).toEqual([
      [0, 2],
      [2, 4],
      [5, 7],
      [7, 9],
    ]);
  });

  it('nested blockquote: every level is hidden, as ONE span per line', () => {
    // "> > nested" — both QuoteMarks are hidden now. They are merged: two
    // adjacent spans would leave an atomic boundary at 2, a stop that prints
    // at the same pixel as 0 and 4 and where typing splits the nested quote.
    expect(spans('> > nested\n')).toEqual([[0, 4]]);
    expect(spans('>> tight\n')).toEqual([[0, 3]]);
    // A lazy continuation line has no marker, and a bare `>` has no space.
    expect(spans('> > a\n> b\n>\n')).toEqual([
      [0, 4],
      [6, 8],
      [10, 11],
    ]);
  });

  it('inline markers inside a quote are hidden like anywhere else', () => {
    // "> a **b** `c`" — the quote prefix, then the pairs of the paragraph.
    expect(spans('> a **b** `c`\n')).toEqual([
      [0, 2],
      [4, 6],
      [7, 9],
      [10, 11],
      [12, 13],
    ]);
  });

  it('a list and a heading inside a quote hide their own markers too', () => {
    expect(spans('> - a\n')).toEqual([
      [0, 2],
      [2, 3],
    ]);
    expect(spans('> ## h\n')).toEqual([
      [0, 2],
      [2, 5],
    ]);
    // Ordered markers stay visible inside a quote, as they do outside one.
    expect(spans('> 1. a\n')).toEqual([[0, 2]]);
  });

  it('a table inside a quote stays raw: only the quote markers are hidden', () => {
    const doc = '> | a | b |\n> | - | - |\n> | **x** | c |\n';
    expect(spans(doc)).toEqual([
      [0, 2],
      [12, 14],
      [24, 26],
    ]);
  });

  it('table cell content is never hidden (Table is always a widget)', () => {
    const doc = '| a | b |\n| - | - |\n| **x** | c |\n';
    expect(spans(doc)).toEqual([]);
  });
});

describe('hiddenMarkRanges — checkbox exclusion', () => {
  it('- [x] done: no hidden span overlaps the CheckboxWidget span', () => {
    // listMark.from=0, checkboxEnd = listMark.to(1)+1+3 = 5 — the widget's
    // own [0,5) swallow zone (lists.ts:66-72). The parser gives this a
    // Task/TaskMarker (not Link), and TaskMarker isn't in HIDDEN_MARK_NODES,
    // so nothing should land here at all — not even the ListMark.
    const result = spans('- [x] done\n');
    for (const [from, to] of result) {
      const overlaps = from < 5 && to > 0;
      expect(overlaps).toBe(false);
    }
    expect(result).toEqual([]);
  });

  it('- [ ] todo: same exclusion', () => {
    expect(spans('- [ ] todo\n')).toEqual([]);
  });

  it('- [x](url) text: the mis-parsed Link is excluded too', () => {
    // Followed by "(" instead of whitespace, @lezer/markdown's TaskList
    // block parser does not fire — this instead parses as a real inline
    // Link `[x](url)` with two LinkMark children. lists.ts's checkbox
    // regex is purely textual and still renders CheckboxWidget over
    // [0,5), so the Link's marks must be excluded or they'd fall inside
    // (and partly outside, for the URL) that widget's span.
    expect(spans('- [x](url) text\n')).toEqual([]);
  });

  it('- [X] Done (uppercase) is not a checkbox in lists.ts and is not excluded', () => {
    // lists.ts:61's regex is case-sensitive (lowercase `x` only). Uppercase
    // parses as Task/TaskMarker at the AST level (TaskList's own regex
    // does accept uppercase) but never gets a CheckboxWidget, and
    // TaskMarker isn't in HIDDEN_MARK_NODES — so the only hidden span here
    // is the ordinary bullet ListMark.
    expect(spans('- [X] Done\n')).toEqual([[0, 1]]);
  });
});

describe('caretNormalizeFilter', () => {
  function stateWithCursor(doc: string, pos: number): EditorState {
    return EditorState.create({
      doc,
      selection: EditorSelection.cursor(pos),
      extensions: [markdownExt, liveRenderAtomic],
    });
  }

  // "**a**" — StrongEmphasis[0,5): opening mark [0,2), closing mark [3,5).
  const doc = '**a**';

  it('every strictly-interior position of the opening marker normalizes to its "from" (outside, before)', () => {
    // [0,2) has exactly one interior position: 1 (an exact tie).
    const state = stateWithCursor(doc, 0);
    const tr = state.update({ selection: EditorSelection.cursor(1) });
    expect(tr.state.selection.main.head).toBe(0);
  });

  it('every strictly-interior position of the closing marker normalizes to its "to" (outside, after)', () => {
    // [3,5) has exactly one interior position: 4 (an exact tie).
    const state = stateWithCursor(doc, 0);
    const tr = state.update({ selection: EditorSelection.cursor(4) });
    expect(tr.state.selection.main.head).toBe(5);
  });

  it('boundary positions (0, 2, 3, 5) are left untouched', () => {
    const state = stateWithCursor(doc, 0);
    for (const pos of [0, 2, 3, 5]) {
      const tr = state.update({ selection: EditorSelection.cursor(pos) });
      expect(tr.state.selection.main.head).toBe(pos);
    }
  });

  it('normalizes a caret inside quoted bold exactly as it does outside a quote', () => {
    // "> **a**" — quote prefix [0,2), opening [2,4), closing [5,7).
    const quoted = '> **a**';
    const state = stateWithCursor(quoted, 0);
    expect(state.update({ selection: EditorSelection.cursor(3) }).state.selection.main.head).toBe(2);
    expect(state.update({ selection: EditorSelection.cursor(6) }).state.selection.main.head).toBe(7);
    expect(state.update({ selection: EditorSelection.cursor(1) }).state.selection.main.head).toBe(0);
    for (const pos of [0, 2, 4, 5, 7]) {
      expect(state.update({ selection: EditorSelection.cursor(pos) }).state.selection.main.head).toBe(pos);
    }
  });

  it('pushes a caret out of a merged nested-quote prefix', () => {
    const state = stateWithCursor('> > x', 0);
    expect(state.update({ selection: EditorSelection.cursor(1) }).state.selection.main.head).toBe(0);
    expect(state.update({ selection: EditorSelection.cursor(2) }).state.selection.main.head).toBe(0);
    expect(state.update({ selection: EditorSelection.cursor(3) }).state.selection.main.head).toBe(4);
  });

  it('normalizes both anchor and head of a non-empty selection', () => {
    const state = stateWithCursor(doc, 0);
    const tr = state.update({ selection: EditorSelection.range(1, 4) });
    expect(tr.state.selection.main.anchor).toBe(0);
    expect(tr.state.selection.main.head).toBe(5);
  });

  it('is a no-op for transactions that do not explicitly set a selection', () => {
    // Construct an initial state whose selection is already "invalid" by
    // our rule (state creation does not run transactionFilter). A change
    // far away, with no explicit `selection` field, must leave it exactly
    // where change-mapping puts it — proving the filter did not touch it.
    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(1),
      extensions: [markdownExt, liveRenderAtomic],
    });
    expect(state.selection.main.head).toBe(1);
    const tr = state.update({ changes: { from: doc.length, to: doc.length, insert: 'x' } });
    expect(tr.state.selection.main.head).toBe(1);
  });
});
