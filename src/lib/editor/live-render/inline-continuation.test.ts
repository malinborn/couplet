import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import { markupModelField } from './atomic';
import {
  findContinuationBoundary,
  planContinuationInsert,
  continuationEscapeSpec,
  continuationFormatKeySpec,
  activeFormatsAt,
  isContinuationActive,
  pendingFormatAt,
  continuationField,
  setPendingFormat,
  type ContinuableKind,
} from './inline-continuation';

function makeState(doc: string, cursor: number): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: [Strikethrough, Table],
      }),
      markupModelField,
      continuationField,
    ],
  });
}

/** Apply a spec and return the resulting state — the shape every assertion below wants. */
function apply(state: EditorState, spec: TransactionSpec | null): EditorState {
  expect(spec).not.toBeNull();
  return state.update(spec!).state;
}

/** The state after a pending format has been recorded at `caret`, as a deflected space would. */
function pending(doc: string, caret: number, spanEnd: number, kind: ContinuableKind): EditorState {
  return makeState(doc, caret).update({ effects: setPendingFormat.of({ caret, spanEnd, kind }) }).state;
}

describe('findContinuationBoundary', () => {
  const cases: { label: string; doc: string; pos: number; kind: ContinuableKind }[] = [
    { label: 'bold', doc: '**bold**', pos: 8, kind: 'strong' },
    { label: 'italic', doc: '*ital*', pos: 6, kind: 'emphasis' },
    { label: 'strikethrough', doc: '~~gone~~', pos: 8, kind: 'strikethrough' },
    { label: 'inline code', doc: '`code`', pos: 6, kind: 'inlineCode' },
  ];

  for (const { label, doc, pos, kind } of cases) {
    it(`detects the closing boundary of ${label}`, () => {
      expect(findContinuationBoundary(makeState(doc, pos), pos)?.kind).toBe(kind);
    });
  }

  it('returns null when the cursor is not at a closing boundary', () => {
    expect(findContinuationBoundary(makeState('plain text here', 5), 5)).toBeNull();
  });

  it('returns null right after the opening marker, not just anywhere inside', () => {
    expect(findContinuationBoundary(makeState('**bold**', 2), 2)).toBeNull();
  });

  it('adjacent spans: **a**_b_ resolves to the preceding (just-closed) span', () => {
    expect(findContinuationBoundary(makeState('**a**_b_', 5), 5)?.kind).toBe('strong');
  });

  it('an inline node flush against the end of the document is still detected', () => {
    const state = makeState('**bold**', 8);
    const boundary = findContinuationBoundary(state, 8);
    expect(boundary?.node.to).toBe(state.doc.length);
  });
});

describe('planContinuationInsert — deflecting a space out of a span (#66)', () => {
  // `ПРивет **как**`: content 9..12, closing marker 12..14.
  const DOC = 'ПРивет **как**';

  it('a space at the inner edge is written outside the closing marker, never inside it', () => {
    const state = makeState(DOC, 12);
    const next = apply(state, planContinuationInsert(state, 12, 12, ' '));
    // `**как **` is what CommonMark rejects; this is the accepted alternative.
    expect(next.doc.toString()).toBe('ПРивет **как** ');
    expect(next.selection.main.head).toBe(15);
  });

  it('and records a pending format, so the caret is already bold before a character is typed', () => {
    const state = makeState(DOC, 12);
    const next = apply(state, planContinuationInsert(state, 12, 12, ' '));
    expect(pendingFormatAt(next, 15)?.kind).toBe('strong');
    expect(activeFormatsAt(next)).toEqual(['strong']);
  });

  it('the next character rejoins the span: `**как** ` + `д` -> `**как д**`', () => {
    const state = pending('ПРивет **как** ', 15, 14, 'strong');
    const next = apply(state, planContinuationInsert(state, 15, 15, 'д'));
    expect(next.doc.toString()).toBe('ПРивет **как д**');
    // Caret back at the inner edge (14, just before the closing `**`), ready to
    // continue with no state at all — the marker moved right past it.
    expect(next.selection.main.head).toBe(14);
    expect(pendingFormatAt(next, 14)).toBeNull();
    expect(activeFormatsAt(next)).toEqual(['strong']);
  });

  it('a letter at the inner edge needs no help — it is already inside and already valid', () => {
    const state = makeState(DOC, 12);
    expect(planContinuationInsert(state, 12, 12, 'x')).toBeNull();
  });

  it('a second space at a pending boundary is inserted plainly and does NOT end the format', () => {
    const state = pending('ПРивет **как** ', 15, 14, 'strong');
    // Falls through to the default insertion...
    expect(planContinuationInsert(state, 15, 15, ' ')).toBeNull();
    // ...and the pending format survives the transaction, so the word after it is still bold.
    const typed = state.update({
      changes: { from: 15, to: 15, insert: ' ' },
      selection: EditorSelection.cursor(16),
    }).state;
    expect(pendingFormatAt(typed, 16)?.kind).toBe('strong');
    const next = apply(typed, planContinuationInsert(typed, 16, 16, 'д'));
    expect(next.doc.toString()).toBe('ПРивет **как  д**');
  });

  for (const [label, doc, inner] of [
    ['italic', 'ПРивет *как*', 11],
    ['strikethrough', 'ПРивет ~~как~~', 12],
  ] as const) {
    it(`deflects for ${label} too`, () => {
      const state = makeState(doc, inner);
      const next = apply(state, planContinuationInsert(state, inner, inner, ' '));
      expect(next.doc.toString()).toBe(`${doc} `);
    });
  }

  it('inline code is left alone — a trailing space there is valid content, not broken markup', () => {
    const state = makeState('ПРивет `как`', 11);
    expect(planContinuationInsert(state, 11, 11, ' ')).toBeNull();
  });

  it('nested spans deflect past the outermost closing marker', () => {
    // `*a **b***`: the inner `**b**` and the outer `*…*` both end their content at 8.
    const state = makeState('*a **b***', 8);
    const next = apply(state, planContinuationInsert(state, 8, 8, ' '));
    expect(next.doc.toString()).toBe('*a **b*** ');
  });

  it('does nothing at the outer edge with nothing pending — a click landed there (#32)', () => {
    const state = makeState('ПРивет **как** и', 14);
    expect(planContinuationInsert(state, 14, 14, 'x')).toBeNull();
    expect(planContinuationInsert(state, 14, 14, ' ')).toBeNull();
  });

  it('ignores range replacements — those are not continuation decisions', () => {
    const state = pending('ПРивет **как** ', 15, 14, 'strong');
    expect(planContinuationInsert(state, 13, 15, 'xx')).toBeNull();
  });
});

describe('continuationField — validated, never remembered', () => {
  it('drops the pending format as soon as the caret moves away', () => {
    const state = pending('ПРивет **как** ', 15, 14, 'strong');
    expect(state.field(continuationField)).not.toBeNull();
    const moved = state.update({ selection: EditorSelection.cursor(3) }).state;
    expect(moved.field(continuationField)).toBeNull();
  });

  it('and does not bring it back when the caret returns', () => {
    const state = pending('ПРивет **как** ', 15, 14, 'strong');
    const away = state.update({ selection: EditorSelection.cursor(3) }).state;
    const back = away.update({ selection: EditorSelection.cursor(15) }).state;
    expect(back.field(continuationField)).toBeNull();
    expect(planContinuationInsert(back, 15, 15, 'д')).toBeNull();
  });

  it('drops it when the gap to the span stops being whitespace', () => {
    const state = pending('ПРивет **как** ', 15, 14, 'strong');
    const edited = state.update({
      changes: { from: 14, to: 15, insert: 'z' },
      selection: EditorSelection.cursor(15),
    }).state;
    expect(edited.field(continuationField)).toBeNull();
  });

  it('does not survive a newline — a marker pair cannot straddle one', () => {
    // Measured in a browser before the line test existed: `**как** ` ⏎ `дальше`
    // absorbed the closing marker across the break and produced
    // `**как \nдальше**` — two lines of literal asterisks, and a destroyed
    // two-space hard break. `\s` matches `\n`; that was the whole bug.
    const state = pending('ПРивет **как** ', 15, 14, 'strong');
    const entered = state.update({
      changes: { from: 15, to: 15, insert: '\n' },
      selection: EditorSelection.cursor(16),
    }).state;
    expect(entered.field(continuationField)).toBeNull();
    expect(planContinuationInsert(entered, 16, 16, 'д')).toBeNull();
  });

  it('maps through an edit earlier in the document', () => {
    const state = pending('ПРивет **как** ', 15, 14, 'strong');
    const edited = state.update({
      changes: { from: 0, to: 0, insert: 'XX' },
      selection: EditorSelection.cursor(17),
    }).state;
    expect(edited.field(continuationField)).toEqual({ caret: 17, spanEnd: 16, kind: 'strong' });
  });
});

describe('the two off switches — neither of which edits the document', () => {
  it('Escape ends a pending format', () => {
    const state = pending('ПРивет **как** ', 15, 14, 'strong');
    const next = apply(state, continuationEscapeSpec(state));
    expect(next.doc.toString()).toBe('ПРивет **как** ');
    expect(next.field(continuationField)).toBeNull();
    expect(activeFormatsAt(next)).toEqual([]);
  });

  it('Escape at the inner edge steps the caret out of the span instead', () => {
    const state = makeState('ПРивет **как**', 12);
    expect(activeFormatsAt(state)).toEqual(['strong']);
    const next = apply(state, continuationEscapeSpec(state));
    expect(next.doc.toString()).toBe('ПРивет **как**');
    expect(next.selection.main.head).toBe(14);
    expect(activeFormatsAt(next)).toEqual([]);
  });

  it('Escape falls through where no inline format is active, so it keeps its other meanings', () => {
    expect(continuationEscapeSpec(makeState('plain text', 5))).toBeNull();
    expect(continuationEscapeSpec(makeState('ПРивет **как** и', 14))).toBeNull();
  });

  it('the matching format key ends a pending format', () => {
    const state = pending('ПРивет **как** ', 15, 14, 'strong');
    const next = apply(state, continuationFormatKeySpec(state, 'strong'));
    expect(next.doc.toString()).toBe('ПРивет **как** ');
    expect(next.field(continuationField)).toBeNull();
  });

  it('a non-matching format key does not end it, and does not fall through to the toggle either', () => {
    const state = pending('ПРивет **как** ', 15, 14, 'strong');
    expect(continuationFormatKeySpec(state, 'emphasis')).toBeNull();
    expect(state.field(continuationField)).not.toBeNull();
  });

  it('the matching format key at the inner edge steps out, without unwrapping the span', () => {
    const state = makeState('ПРивет **как**', 12);
    const next = apply(state, continuationFormatKeySpec(state, 'strong'));
    expect(next.doc.toString()).toBe('ПРивет **как**');
    expect(next.selection.main.head).toBe(14);
  });

  it('the format key at the outer edge starts a pending format — #32 opt-in, unchanged', () => {
    const state = makeState('ПРивет **как** и', 14);
    const next = apply(state, continuationFormatKeySpec(state, 'strong'));
    expect(next.doc.toString()).toBe('ПРивет **как** и');
    expect(pendingFormatAt(next, 14)?.kind).toBe('strong');
    const typed = apply(next, planContinuationInsert(next, 14, 14, 'x'));
    expect(typed.doc.toString()).toBe('ПРивет **какx** и');
  });

  it('pressing it twice at the outer edge is a toggle, not a latch', () => {
    const state = makeState('ПРивет **как** и', 14);
    const on = apply(state, continuationFormatKeySpec(state, 'strong'));
    const off = apply(on, continuationFormatKeySpec(on, 'strong'));
    expect(off.field(continuationField)).toBeNull();
  });

  it('returns null away from any span, so the key stays the ordinary toggle', () => {
    expect(continuationFormatKeySpec(makeState('plain text', 5), 'strong')).toBeNull();
  });

  it('returns null when the live-render bundle is not installed', () => {
    const withoutField = EditorState.create({
      doc: '**bold**',
      selection: EditorSelection.cursor(8),
      extensions: [markdown({ base: markdownLanguage, extensions: [Strikethrough, Table] })],
    });
    expect(continuationFormatKeySpec(withoutField, 'strong')).toBeNull();
  });
});

describe('activeFormatsAt — the data behind the format-aware caret (#67)', () => {
  it('is empty in plain prose and in an empty document', () => {
    expect(activeFormatsAt(makeState('plain text', 5))).toEqual([]);
    expect(activeFormatsAt(makeState('', 0))).toEqual([]);
  });

  it('reports the format the caret is inside', () => {
    expect(activeFormatsAt(makeState('ПРивет **как**', 10))).toEqual(['strong']);
    expect(activeFormatsAt(makeState('ПРивет *как*', 10))).toEqual(['emphasis']);
    expect(activeFormatsAt(makeState('ПРивет ~~как~~', 10))).toEqual(['strikethrough']);
    expect(activeFormatsAt(makeState('ПРивет `как`', 10))).toEqual(['inlineCode']);
  });

  it('paints the #32 offset distinction: bold at the inner edge, plain at the outer one', () => {
    const doc = 'ПРивет **как** и';
    expect(activeFormatsAt(makeState(doc, 12))).toEqual(['strong']); // arrows / typing land here
    expect(activeFormatsAt(makeState(doc, 14))).toEqual([]); //          a click lands here
  });

  it('reports every applicable format for a combined span rather than picking a winner', () => {
    expect(activeFormatsAt(makeState('***оба***', 4)).sort()).toEqual(['emphasis', 'strong']);
  });

  it('reports the pending format before the first character exists', () => {
    const state = pending('ПРивет **как** ', 15, 14, 'strong');
    expect(activeFormatsAt(state)).toEqual(['strong']);
    expect(isContinuationActive(state)).toBe('strong');
  });

  it('is empty for a range selection — there is no single next character', () => {
    const state = EditorState.create({
      doc: 'ПРивет **как**',
      selection: EditorSelection.range(9, 12),
      extensions: [
        markdown({ base: markdownLanguage, extensions: [Strikethrough, Table] }),
        markupModelField,
        continuationField,
      ],
    });
    expect(activeFormatsAt(state)).toEqual([]);
  });
});
