import { describe, it, expect, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import { computeBlockFormatRemoval, removeBlockFormatBackward } from './block-format';

// Same markdown config as setup.ts:44-48 — parse shapes (esp. lazy
// continuation for lists/blockquotes) depend on this exact extension set.
function makeState(doc: string, pos: number): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: [Strikethrough, Table],
      }),
    ],
  });
}

// Applies the plan returned by computeBlockFormatRemoval and reports both
// the resulting document text and the resulting caret offset.
function apply(doc: string, pos: number): { doc: string; caret: number } | null {
  const state = makeState(doc, pos);
  const result = computeBlockFormatRemoval(state);
  if (!result) return null;
  const next = state.update({
    changes: result.changes,
    selection: EditorSelection.cursor(result.caret),
  }).state;
  return { doc: next.doc.toString(), caret: next.selection.main.head };
}

// Structural mock — same pattern as format-commands.test.ts's makeMockView.
// removeBlockFormatBackward only reads `view.state` and calls `view.dispatch`.
function makeMockView(
  doc: string,
  pos: number
): { view: EditorView; dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn();
  const state = makeState(doc, pos);
  const view = { state, dispatch } as unknown as EditorView;
  return { view, dispatch };
}

describe('computeBlockFormatRemoval — headings', () => {
  it('Heading_CaretAtContentStart_ReturnsNull', () => {
    // deleteBy + skipAtomic (live-render/atomic.ts) already remove the whole
    // "## " prefix in one press — no custom command needed.
    expect(apply('## Heading\n', 3)).toBeNull();
  });
});

describe('computeBlockFormatRemoval — bullet lists', () => {
  it('FirstItem_TwoItems_BecomesParagraphFollowedByList', () => {
    // "- a\n- b\n" caret at "a" (pos 2) -> "a\n\n- b\n"
    expect(apply('- a\n- b\n', 2)).toEqual({ doc: 'a\n\n- b\n', caret: 0 });
  });

  it('MiddleItem_ThreeItems_SplitsListAroundEjectedParagraph', () => {
    // "- a\n- b\n- c\n" caret at "b" (pos 6) -> "- a\n\nb\n\n- c\n"
    expect(apply('- a\n- b\n- c\n', 6)).toEqual({ doc: '- a\n\nb\n\n- c\n', caret: 5 });
  });

  it('LastItem_TwoItems_BecomesTrailingParagraph', () => {
    // "- a\n- b\n" caret at "b" (pos 6) -> "- a\n\nb\n"
    expect(apply('- a\n- b\n', 6)).toEqual({ doc: '- a\n\nb\n', caret: 5 });
  });

  it('SoleItem_BecomesPlainParagraph', () => {
    // "- a\n" caret at "a" (pos 2) -> "a\n"
    expect(apply('- a\n', 2)).toEqual({ doc: 'a\n', caret: 0 });
  });

  it('MultiLineItem_ContinuationTravelsWithEjectedItem', () => {
    // "- a\n- b\ncontinued\n- c\n" caret at "b" (pos 6):
    // item "b" spans "- b\ncontinued" — the continuation line must eject with it.
    expect(apply('- a\n- b\ncontinued\n- c\n', 6)).toEqual({
      doc: '- a\n\nb\ncontinued\n\n- c\n',
      caret: 5,
    });
  });

  it('NestedItem_Indented_OutdentsOneLevelInsteadOfEjecting', () => {
    // "- outer\n  - inner\n" caret at "inner" (pos 12) -> outdent to sibling of "outer"
    expect(apply('- outer\n  - inner\n', 12)).toEqual({
      doc: '- outer\n- inner\n',
      caret: 10,
    });
  });
});

describe('computeBlockFormatRemoval — item starting with a hidden marker', () => {
  it('SoleItemStartingWithBold_CaretPastOpeningMarker_BecomesParagraph', () => {
    // "- **b**" caret at "b" (pos 4): the start of the item on screen.
    expect(apply('- **b**\n', 4)).toEqual({ doc: '**b**\n', caret: 2 });
  });
});

describe('computeBlockFormatRemoval — ordered lists', () => {
  it('MiddleItem_ThreeItems_SplitsListSameAsBullet', () => {
    // "1. a\n2. b\n3. c\n" caret at "b" (pos 8) -> "1. a\n\nb\n\n3. c\n"
    // Note: the trailing list now restarts at "3." (no renumbering in v1) —
    // accepted per plan; CommonMark uses the first item's own number as the
    // list's start value, so it renders starting at 3.
    expect(apply('1. a\n2. b\n3. c\n', 8)).toEqual({
      doc: '1. a\n\nb\n\n3. c\n',
      caret: 6,
    });
  });

  it('SoleItem_BecomesPlainParagraph', () => {
    expect(apply('1. a\n', 3)).toEqual({ doc: 'a\n', caret: 0 });
  });
});

describe('computeBlockFormatRemoval — blockquotes', () => {
  it('SoleLine_BecomesPlainParagraph', () => {
    // "> a\n" caret at "a" (pos 2) -> "a\n"
    expect(apply('> a\n', 2)).toEqual({ doc: 'a\n', caret: 0 });
  });

  it('FirstLine_TwoLines_BecomesParagraphFollowedByBlockquote', () => {
    // "> a\n> b\n" caret at "a" (pos 2) -> "a\n\n> b\n". A bare "> b" would
    // actually reopen its own quote fine even without the blank line (verified
    // empirically), but the blank is inserted anyway — same symmetric
    // treatment as the list-splitting cases, for consistent visual spacing.
    expect(apply('> a\n> b\n', 2)).toEqual({ doc: 'a\n\n> b\n', caret: 0 });
  });

  it('LastLine_TwoLines_BecomesTrailingParagraph', () => {
    // "> a\n> b\n" caret at "b" (pos 6) -> "> a\n\nb\n"
    expect(apply('> a\n> b\n', 6)).toEqual({ doc: '> a\n\nb\n', caret: 5 });
  });

  it('MiddleLine_ThreeLines_SplitsBlockquoteAroundEjectedParagraph', () => {
    // "> a\n> b\n> c\n" caret at "b" (pos 6) -> "> a\n\nb\n\n> c\n"
    expect(apply('> a\n> b\n> c\n', 6)).toEqual({ doc: '> a\n\nb\n\n> c\n', caret: 5 });
  });

  it('LineStartingWithBold_CaretPastHiddenOpeningMarker_StillStrips', () => {
    // "> **bold** x" caret at "b" (pos 4) — visually the start of the line's
    // content, because `**` is hidden. Without this the Backspace would fall
    // through and delete the hidden space after ">".
    expect(apply('> **bold** x\n', 4)).toEqual({ doc: '**bold** x\n', caret: 2 });
    expect(apply('> > *i*\n', 5)).toEqual({ doc: '> *i*\n', caret: 3 });
  });

  it('NestedBlockquote_LosesOneLevelOnly', () => {
    // "> > nested\n" caret at "nested" (pos 4) -> "> nested\n"
    expect(apply('> > nested\n', 4)).toEqual({ doc: '> nested\n', caret: 2 });
  });
});

describe('computeBlockFormatRemoval — lists inside a blockquote', () => {
  // Rendered since quotes are descended into: the bullet is hidden, so a
  // default Backspace here would eat the visible space and leave `-a` behind.
  it('QuotedSoleItem_BecomesQuoteParagraph', () => {
    expect(apply('> - a\n', 4)).toEqual({ doc: '> a\n', caret: 2 });
  });

  it('QuotedOrderedItem_BecomesQuoteParagraph', () => {
    expect(apply('> 1. a\n', 5)).toEqual({ doc: '> a\n', caret: 2 });
  });

  it('QuotedFirstItem_TwoItems_SeparatedByBlankQuoteLine', () => {
    // A bare "> a" directly above "> - b" is fine, but the blank quote line
    // keeps the ejected paragraph symmetric with the unquoted case.
    expect(apply('> - a\n> - b\n', 4)).toEqual({ doc: '> a\n>\n> - b\n', caret: 2 });
  });

  it('QuotedLastItem_TwoItems_BlankQuoteLineKeepsItOutOfTheItemAbove', () => {
    // Without the blank "> " line, "> b" is a lazy continuation of item "a".
    expect(apply('> - a\n> - b\n', 10)).toEqual({ doc: '> - a\n>\n> b\n', caret: 10 });
  });

  it('QuotedNestedItem_OutdentsOneLevel_KeepingTheQuote', () => {
    expect(apply('> - a\n>   - b\n', 12)).toEqual({ doc: '> - a\n> - b\n', caret: 10 });
  });

  it('QuotedItemStartingWithBold_CaretPastHiddenOpeningMarker_StillStrips', () => {
    // "> - **b**": the caret the user sees at the start of "b" is at 6, past
    // the hidden `**`. It stays inside the bold after the strip.
    expect(apply('> - **b**\n', 6)).toEqual({ doc: '> **b**\n', caret: 4 });
  });

  it('QuoteInsideListItem_SeparatorUsesTheContinuationPrefix_NotTheOuterMarker', () => {
    // "- > - a\n  > - b": the quote sits in an outer list item. The blank
    // quote line must continue that item ("  >"), not repeat "- >", which
    // would open a new outer item.
    expect(apply('- > - a\n  > - b\n', 6)).toEqual({ doc: '- > a\n  >\n  > - b\n', caret: 4 });
    expect(apply('1. > - a\n   > - b\n', 7)).toEqual({ doc: '1. > a\n   >\n   > - b\n', caret: 5 });
  });

  it('ItemInsideNestedQuote_KeepsBothQuoteLevels', () => {
    expect(apply('> > - a\n', 6)).toEqual({ doc: '> > a\n', caret: 4 });
  });
});

describe('computeBlockFormatRemoval — negative cases', () => {
  it('CaretMidLine_ReturnsNull', () => {
    expect(apply('- hello world\n', 8)).toBeNull();
  });

  it('CaretInPlainParagraph_ReturnsNull', () => {
    expect(apply('just some text\n', 5)).toBeNull();
  });

  it('CaretAtStartOfPlainParagraph_ReturnsNull', () => {
    expect(apply('just some text\n', 0)).toBeNull();
  });

  it('EmptyDocument_ReturnsNull', () => {
    expect(apply('', 0)).toBeNull();
  });

  it('CaretAtStartOfListContinuationLine_ReturnsNull', () => {
    // "continued" has no marker of its own — it's a lazy-continuation line,
    // not a block start, so the default Backspace (join lines) should run.
    expect(apply('- a\ncontinued\n', 4)).toBeNull();
  });

  it('CaretAtStartOfQuoteContinuationLine_WithoutOwnMarker_ReturnsNull', () => {
    // A quote continuation line that has no leading ">" at all (lazily
    // joined into the paragraph) carries no marker to strip.
    expect(apply('> a\ncontinued\n', 4)).toBeNull();
  });

  it('NonEmptySelection_ReturnsNull', () => {
    const state = EditorState.create({
      doc: '- a\n- b\n',
      selection: { anchor: 6, head: 7 },
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, Table] }),
      ],
    });
    expect(computeBlockFormatRemoval(state)).toBeNull();
  });
});

describe('removeBlockFormatBackward — command wiring', () => {
  it('returns false and does not dispatch when no block format applies', () => {
    const { view, dispatch } = makeMockView('just text\n', 3);
    expect(removeBlockFormatBackward(view)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches the computed change and places the caret, returning true', () => {
    const { view, dispatch } = makeMockView('- a\n- b\n', 6);
    expect(removeBlockFormatBackward(view)).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const spec = dispatch.mock.calls[0][0];
    const next = view.state.update(spec).state;
    expect(next.doc.toString()).toBe('- a\n\nb\n');
    expect(next.selection.main.head).toBe(5);
  });
});
