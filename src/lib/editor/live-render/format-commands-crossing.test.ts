import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from '../markdown-language';
import { liveRenderExtensions } from './index';
import {
  toggleInlineFormat,
  toggleInlineFormatAt,
  toggleInlineFormatInText,
  type InlineFormatKind,
} from './format-commands';

/**
 * A selection that crosses another inline span (#crossing).
 *
 * Wrapping the raw selected source used to produce *crossing* markup —
 * `**выдели ***слово** и нажми*` — and in live-render the repair filter then
 * read the new pair's range as having torn the bold pair and wrote a `**` back,
 * so raw asterisks appeared on screen. The command now splits the selection at
 * the other span's hidden markers and wraps each piece, which is well-nested by
 * construction.
 *
 * Every case asserts the parse as well as the string: Lezer decides what
 * renders, and a plausible-looking string that parses as literal asterisks is
 * exactly the bug.
 */

/**
 * A state carrying the whole live-render bundle, so `markupRepairFilter` and
 * `markupWhitespaceFilter` run on the command's transaction exactly as they do
 * in the app. The tree is forced first: the filters read `markupModelField`,
 * which is only as good as the parse under it.
 */
function liveState(doc: string, from: number, to: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(from, to),
    extensions: [markdownExtension(), liveRenderExtensions()],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

/** A view stand-in whose `dispatch` really applies the spec (filters included). */
function runLive(doc: string, from: number, to: number, kind: InlineFormatKind): EditorState {
  let current = liveState(doc, from, to);
  const view = {
    get state() {
      return current;
    },
    dispatch(spec: TransactionSpec) {
      current = current.update(spec).state;
    },
  } as unknown as EditorView;
  toggleInlineFormat(view, kind);
  // Re-create so the returned state's tree is a full parse of the new text.
  const text = current.doc.toString();
  const sel = current.selection.main;
  const parsed = liveState(text, sel.from, sel.to);
  return parsed;
}

/** Source text of every node named `name`, in document order. */
function nodes(state: EditorState, name: string): string[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  expect(tree).not.toBeNull();
  const out: string[] = [];
  tree!.iterate({
    enter(n) {
      if (n.name === name) out.push(state.sliceDoc(n.from, n.to));
    },
  });
  return out;
}

function parse(text: string): EditorState {
  return liveState(text, 0, 0);
}

function selected(state: EditorState): string {
  return state.sliceDoc(state.selection.main.from, state.selection.main.to);
}

/** `[from, to)` of `needle` in `hay`, failing loudly if it is absent. */
function rangeOf(hay: string, needle: string, fromIndex = 0): [number, number] {
  const at = hay.indexOf(needle, fromIndex);
  expect(at).toBeGreaterThanOrEqual(0);
  return [at, at + needle.length];
}

describe('crossing selection — the reported case', () => {
  const PLAIN = 'Попробуй здесь: выдели слово и нажми ⌘B';
  const BOLD = 'Попробуй здесь: **выдели слово** и нажми ⌘B';
  const EXPECTED = 'Попробуй здесь: **выдели *слово*** *и нажми* ⌘B';

  it('Step1_BoldOverPlainText_IsTheOrdinaryWrap', () => {
    const [from, to] = rangeOf(PLAIN, 'выдели слово');
    const result = runLive(PLAIN, from, to, 'strong');
    expect(result.doc.toString()).toBe(BOLD);
    expect(nodes(result, 'StrongEmphasis')).toEqual(['**выдели слово**']);
  });

  it('Step2_ItalicAcrossTheHiddenClosingBold_NestsInsteadOfCrossing', () => {
    // The visible selection "слово и нажми" is `слово** и нажми` in source:
    // it contains the bold span's hidden closing `**`.
    const from = BOLD.indexOf('слово');
    const to = BOLD.indexOf('нажми') + 'нажми'.length;
    expect(BOLD.slice(from, to)).toBe('слово** и нажми');

    const result = runLive(BOLD, from, to, 'emphasis');

    expect(result.doc.toString()).toBe(EXPECTED);
    expect(nodes(result, 'StrongEmphasis')).toEqual(['**выдели *слово***']);
    expect(nodes(result, 'Emphasis')).toEqual(['*слово*', '*и нажми*']);
    // Same visible text as before, markers and all in between.
    expect(selected(result)).toBe('слово*** *и нажми');
  });

  it('ReverseOrder_BoldAcrossTheHiddenClosingItalic_NestsToo', () => {
    const plain = 'выдели слово и нажми';
    const [a, b] = rangeOf(plain, 'выдели слово');
    const italic = runLive(plain, a, b, 'emphasis');
    expect(italic.doc.toString()).toBe('*выдели слово* и нажми');

    const text = italic.doc.toString();
    const from = text.indexOf('слово');
    const to = text.indexOf('нажми') + 'нажми'.length;
    const result = runLive(text, from, to, 'strong');

    expect(result.doc.toString()).toBe('*выдели **слово*** **и нажми**');
    expect(nodes(result, 'Emphasis')).toEqual(['*выдели **слово***']);
    expect(nodes(result, 'StrongEmphasis')).toEqual(['**слово**', '**и нажми**']);
  });

  it('TableCellOverlay_SamePathSameResult', () => {
    // `toggleInlineFormatInText` is the cell edit overlay's carrier (#60). It
    // must reach the same answer from the same `formatSpec`.
    const cell = '**выдели слово** и нажми';
    const from = cell.indexOf('слово');
    const to = cell.length;
    const result = toggleInlineFormatInText(cell, 'emphasis', from, to);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('**выдели *слово*** *и нажми*');
    expect(result!.text.slice(result!.from, result!.to)).toBe('слово*** *и нажми');
    const parsed = parse(result!.text);
    expect(nodes(parsed, 'StrongEmphasis')).toEqual(['**выдели *слово***']);
    expect(nodes(parsed, 'Emphasis')).toEqual(['*слово*', '*и нажми*']);
  });

  it('ExplicitRangePath_TableWidget_SameResult', () => {
    // `toggleInlineFormatAt` — the rendered-table-cell path (#55).
    let current = liveState(BOLD, 0, 0);
    const view = {
      get state() {
        return current;
      },
      dispatch(spec: TransactionSpec) {
        current = current.update(spec).state;
      },
    } as unknown as EditorView;
    const from = BOLD.indexOf('слово');
    const to = BOLD.indexOf('нажми') + 'нажми'.length;
    expect(toggleInlineFormatAt(view, 'emphasis', from, to)).toBe(true);
    expect(current.doc.toString()).toBe(EXPECTED);
  });
});

describe('crossing selection — other shapes', () => {
  it('SelectionStartsBeforeASpanAndEndsInsideIt_SplitsAtTheOpeningMarker', () => {
    const doc = 'a **bold** c';
    const from = 0;
    const to = doc.indexOf('ld'); // "a **bo"
    const result = runLive(doc, from, to, 'emphasis');
    expect(result.doc.toString()).toBe('*a* ***bo*ld** c');
    expect(nodes(result, 'Emphasis')).toEqual(['*a*', '*bo*']);
    expect(nodes(result, 'StrongEmphasis')).toEqual(['***bo*ld**']);
  });

  it('SelectionCrossingALink_MarkersGoInsideTheLinkTextAndAfterIt', () => {
    const doc = '[link text](url) after';
    const from = doc.indexOf('text');
    const to = doc.length;
    const result = runLive(doc, from, to, 'emphasis');
    expect(result.doc.toString()).toBe('[link *text*](url) *after*');
    expect(nodes(result, 'Link')).toEqual(['[link *text*](url)']);
    expect(nodes(result, 'URL')).toEqual(['url']);
    expect(nodes(result, 'Emphasis')).toEqual(['*text*', '*after*']);
  });

  it('SelectionEnteringALinkFromBefore_SplitsAtTheOpeningBracket', () => {
    const doc = 'before [link](u)';
    const from = 0;
    const to = doc.indexOf('nk'); // "before [li"
    const result = runLive(doc, from, to, 'strong');
    expect(result.doc.toString()).toBe('**before** [**li**nk](u)');
    expect(nodes(result, 'Link')).toEqual(['[**li**nk](u)']);
    expect(nodes(result, 'StrongEmphasis')).toEqual(['**before**', '**li**']);
  });

  it('SelectionStartingInsideInlineCode_MarkersGoOutsideTheCodeSpan', () => {
    // Markup inside backticks is literal, so a marker can never go in there:
    // the boundary snaps outward to the whole code span.
    const doc = 'a `code` b';
    const from = doc.indexOf('de');
    const to = doc.length;
    const result = runLive(doc, from, to, 'emphasis');
    expect(result.doc.toString()).toBe('a *`code` b*');
    expect(nodes(result, 'Emphasis')).toEqual(['*`code` b*']);
    expect(nodes(result, 'InlineCode')).toEqual(['`code`']);
  });

  it('SelectionEndingInsideInlineCode_MarkersGoOutsideTheCodeSpan', () => {
    const doc = 'a `code` b';
    const from = 0;
    const to = doc.indexOf('de'); // "a `co"
    const result = runLive(doc, from, to, 'strong');
    expect(result.doc.toString()).toBe('**a `code`** b');
    expect(nodes(result, 'StrongEmphasis')).toEqual(['**a `code`**']);
    expect(nodes(result, 'InlineCode')).toEqual(['`code`']);
  });

  it('SpanWhollyInsideTheSelection_IsLeftNestedNotSplit', () => {
    // A span with both markers inside the selection is already well-nested
    // inside the new wrap — splitting around it would only fragment the italic.
    const doc = 'a **b** c';
    const result = runLive(doc, 0, doc.length, 'emphasis');
    expect(result.doc.toString()).toBe('*a **b** c*');
    expect(nodes(result, 'Emphasis')).toEqual(['*a **b** c*']);
    expect(nodes(result, 'StrongEmphasis')).toEqual(['**b**']);
  });
});

describe('crossing selection — same kind merges', () => {
  it('Emphasis_OverlappingAnEmphasis_ExtendsToTheUnion', () => {
    const doc = '*a b* c';
    const [from, to] = rangeOf(doc, 'b* c');
    const result = runLive(doc, from, to, 'emphasis');
    expect(result.doc.toString()).toBe('*a b c*');
    expect(nodes(result, 'Emphasis')).toEqual(['*a b c*']);
    expect(selected(result)).toBe('b c');
  });

  it('Strong_StartsInsideBoldEndsPastIt_ExtendsToTheUnion', () => {
    // Used to wrap verbatim into `**bo**ld** re**st`.
    const doc = '**bold** rest';
    const result = runLive(doc, 4, 11, 'strong');
    expect(result.doc.toString()).toBe('**bold re**st');
    expect(nodes(result, 'StrongEmphasis')).toEqual(['**bold re**']);
    expect(selected(result)).toBe('ld re');
  });

  it('Emphasis_SelectionCoversAWholeEmphasis_AbsorbsItsMarkers', () => {
    const doc = 'a *b* c';
    const result = runLive(doc, 0, doc.length, 'emphasis');
    expect(result.doc.toString()).toBe('*a b c*');
    expect(nodes(result, 'Emphasis')).toEqual(['*a b c*']);
  });

  it('InlineCode_OverlappingInlineCode_ExtendsToTheUnion', () => {
    const doc = 'a `code` b';
    const from = doc.indexOf('de');
    const result = runLive(doc, from, doc.length, 'inlineCode');
    expect(result.doc.toString()).toBe('a `code b`');
    expect(nodes(result, 'InlineCode')).toEqual(['`code b`']);
  });

  it('MergeAlsoSplitsAtAnOuterCrossingSpan', () => {
    // Italic `*a **b c** d*` is crossed by a bold selection "c** d* e": the
    // bold merges with the selection, and the italic's closing marker — which
    // now lies inside the union — splits it.
    const doc = '*a **b c** d* e';
    const from = doc.indexOf('c**');
    const result = runLive(doc, from, doc.length, 'strong');
    expect(result.doc.toString()).toBe('*a **b c d*** **e**');
    expect(nodes(result, 'Emphasis')).toEqual(['*a **b c d***']);
    expect(nodes(result, 'StrongEmphasis')).toEqual(['**b c d**', '**e**']);
  });
});
