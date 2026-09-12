import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import {
  findContinuationBoundary,
  continuationRedirect,
  continuationEscapeSpec,
  continuationFormatArmSpec,
  isContinuationActive,
  armedBoundaryField,
  setArmedBoundary,
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
      armedBoundaryField,
    ],
  });
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
      const state = makeState(doc, pos);
      const boundary = findContinuationBoundary(state, pos);
      expect(boundary?.kind).toBe(kind);
    });
  }

  it('returns null when the cursor is not at a closing boundary', () => {
    const state = makeState('plain text here', 5);
    expect(findContinuationBoundary(state, 5)).toBeNull();
  });

  it('returns null right after the opening marker, not just anywhere inside', () => {
    // "**bold**": position 2 is right after the opening "**", not a closing boundary.
    const state = makeState('**bold**', 2);
    expect(findContinuationBoundary(state, 2)).toBeNull();
  });

  it('adjacent spans: **a**_b_ resolves to the preceding (just-closed) span, not the one about to open', () => {
    const doc = '**a**_b_';
    // "**a**" is [0,5), "_b_" is [5,8) — position 5 is StrongEmphasis.to and Emphasis.from at once.
    const state = makeState(doc, 5);
    const boundary = findContinuationBoundary(state, 5);
    expect(boundary?.kind).toBe('strong');
  });

  it('an inline node flush against the end of the document is still detected', () => {
    // No trailing character after the closing marker at all — the case that
    // ruled out an arrow-key-based exit (no pixel to move the caret to).
    const state = makeState('**bold**', 8);
    const boundary = findContinuationBoundary(state, 8);
    expect(boundary).not.toBeNull();
    expect(boundary?.node.to).toBe(state.doc.length);
  });
});

describe('continuationRedirect', () => {
  /** Arm the boundary the way Cmd+B does, so the redirect has something to act on. */
  function armed(doc: string, pos: number): EditorState {
    return makeState(doc, pos).update({ effects: setArmedBoundary.of(pos) }).state;
  }

  it('continues bold once armed: typed text lands inside, before the closing **', () => {
    const state = armed('**bold**', 8);
    const spec = continuationRedirect(state, 8, 8, '!');
    expect(spec).not.toBeNull();
    expect(state.update(spec!).state.doc.toString()).toBe('**bold!**');
  });

  it('continues italic once armed', () => {
    const state = armed('*ital*', 6);
    expect(state.update(continuationRedirect(state, 6, 6, '!')!).state.doc.toString()).toBe('*ital!*');
  });

  it('continues strikethrough once armed', () => {
    const state = armed('~~gone~~', 8);
    expect(state.update(continuationRedirect(state, 8, 8, '!')!).state.doc.toString()).toBe('~~gone!~~');
  });

  it('continues inline code once armed', () => {
    const state = armed('`code`', 6);
    expect(state.update(continuationRedirect(state, 6, 6, '!')!).state.doc.toString()).toBe('`code!`');
  });

  it('DECLINES at an unarmed boundary — the default is to type outside the span', () => {
    // Product decision #1 for issue #32, and the case the user actually hit:
    // click in the space after a bold word, type, and get bold. The caret is at
    // 8, outside the span; nothing redirects it back in any more.
    const state = makeState('**bold**', 8);
    expect(continuationRedirect(state, 8, 8, '!')).toBeNull();
    const typed = state.update({ changes: { from: 8, to: 8, insert: '!' } }).state;
    expect(typed.doc.toString()).toBe('**bold**!');
  });

  it('arming one boundary does not arm a different one', () => {
    const state = makeState('**a** **b**', 5).update({ effects: setArmedBoundary.of(5) }).state;
    expect(continuationRedirect(state, 11, 11, '!')).toBeNull();
  });

  it('leaves typing elsewhere untouched', () => {
    const state = makeState('plain text here', 5);
    expect(continuationRedirect(state, 5, 5, 'x')).toBeNull();
  });

  it('leaves a range replacement (from !== to) untouched', () => {
    const state = armed('**bold** and more', 8);
    expect(continuationRedirect(state, 6, 8, 'xx')).toBeNull();
  });
});

describe('Escape disarms continuation', () => {
  it('clears arming, and a subsequent type lands outside again', () => {
    const state = makeState('**bold**', 8).update({ effects: setArmedBoundary.of(8) }).state;
    expect(continuationRedirect(state, 8, 8, 'x')).not.toBeNull();

    const escSpec = continuationEscapeSpec(state);
    expect(escSpec).not.toBeNull();
    const afterEscape = state.update(escSpec!).state;
    expect(afterEscape.field(armedBoundaryField)).toBeNull();

    expect(continuationRedirect(afterEscape, 8, 8, 'x')).toBeNull();
    const typed = afterEscape.update({ changes: { from: 8, to: 8, insert: 'x' } }).state;
    expect(typed.doc.toString()).toBe('**bold**x');
  });

  it('declines when nothing is armed, leaving other Escape handlers free to run', () => {
    // Escape also clears AI highlights and closes panels. With continuation now
    // opt-in, "not armed" is the common state at a boundary, so this handler
    // must not swallow the key there.
    const state = makeState('**bold**', 8);
    expect(continuationEscapeSpec(state)).toBeNull();
  });

  it('does nothing away from a boundary', () => {
    expect(continuationEscapeSpec(makeState('plain text', 5))).toBeNull();
  });

  it('does nothing when the selection is not empty', () => {
    const state = makeState('**bold** more', 8).update({
      selection: EditorSelection.range(6, 8),
    }).state;
    expect(continuationEscapeSpec(state)).toBeNull();
  });
});

describe('arming lifecycle', () => {
  it('clears when the caret moves away, and does not come back with it', () => {
    const state = makeState('**bold**', 8).update({ effects: setArmedBoundary.of(8) }).state;
    expect(state.field(armedBoundaryField)).toBe(8);

    const movedAway = state.update({ selection: EditorSelection.cursor(2) }).state;
    expect(movedAway.field(armedBoundaryField)).toBeNull();

    const movedBack = movedAway.update({ selection: EditorSelection.cursor(8) }).state;
    expect(movedBack.field(armedBoundaryField)).toBeNull();
    // Arming is a one-shot, not a mode: returning to the boundary types outside
    // again, exactly as arriving there for the first time would.
    expect(continuationRedirect(movedBack, 8, 8, '!')).toBeNull();
  });

  it('maps the armed position through an edit earlier in the document', () => {
    const state = makeState('abc **bold**', 12).update({ effects: setArmedBoundary.of(12) }).state;
    expect(state.field(armedBoundaryField)).toBe(12);

    const edited = state.update({ changes: { from: 0, to: 0, insert: 'XY' } }).state;
    expect(edited.selection.main.head).toBe(14);
    expect(edited.field(armedBoundaryField)).toBe(14);
  });

  it('an explicit null effect clears arming directly', () => {
    const state = makeState('**bold**', 8).update({ effects: setArmedBoundary.of(8) }).state;
    expect(state.update({ effects: setArmedBoundary.of(null) }).state.field(armedBoundaryField)).toBeNull();
  });
});

describe('continuationFormatArmSpec (Cmd+B-family arm contract)', () => {
  it('arms when the kind matches the boundary', () => {
    const state = makeState('**bold**', 8);
    const spec = continuationFormatArmSpec(state, 'strong');
    expect(spec).not.toBeNull();
    const result = state.update(spec!).state;
    expect(result.field(armedBoundaryField)).toBe(8);
    // And the next character then joins the bold, which is the point.
    expect(result.update(continuationRedirect(result, 8, 8, '!')!).state.doc.toString()).toBe('**bold!**');
  });

  it('pressing the key again at the same boundary disarms — it reads as a toggle', () => {
    const state = makeState('**bold**', 8);
    const on = state.update(continuationFormatArmSpec(state, 'strong')!).state;
    const off = on.update(continuationFormatArmSpec(on, 'strong')!).state;
    expect(off.field(armedBoundaryField)).toBeNull();
  });

  it('does not arm when the kind does not match the boundary', () => {
    const state = makeState('**bold**', 8);
    expect(continuationFormatArmSpec(state, 'emphasis')).toBeNull();
    expect(continuationFormatArmSpec(state, 'strikethrough')).toBeNull();
  });

  it('does nothing away from any boundary, so Cmd+B still wraps normally', () => {
    expect(continuationFormatArmSpec(makeState('plain text', 5), 'strong')).toBeNull();
  });

  it('does nothing when the field is absent, so live-preview keeps Cmd+B', () => {
    // keybindings.ts is shared with live-preview, where the live-render bundle
    // — and therefore this field — is not installed. Returning a spec here
    // would swallow Cmd+B at the end of a bold span in the existing mode.
    const withoutField = EditorState.create({
      doc: '**bold**',
      selection: EditorSelection.cursor(8),
      extensions: [
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          extensions: [Strikethrough, Table],
        }),
      ],
    });
    expect(findContinuationBoundary(withoutField, 8)?.kind).toBe('strong');
    expect(continuationFormatArmSpec(withoutField, 'strong')).toBeNull();
  });
});

describe('isContinuationActive (caret affordance)', () => {
  it('is null at a fresh boundary — nothing to advertise when typing goes outside', () => {
    expect(isContinuationActive(makeState('**bold**', 8))).toBeNull();
  });

  it('is active once armed', () => {
    const state = makeState('**bold**', 8).update({ effects: setArmedBoundary.of(8) }).state;
    expect(isContinuationActive(state)).toBe('strong');
  });

  it('is null again after Escape', () => {
    const on = makeState('**bold**', 8).update({ effects: setArmedBoundary.of(8) }).state;
    expect(isContinuationActive(on.update(continuationEscapeSpec(on)!).state)).toBeNull();
  });

  it('is null when not at a boundary', () => {
    expect(isContinuationActive(makeState('plain text', 5))).toBeNull();
  });

  it('is null with a non-empty selection', () => {
    const state = makeState('**bold** more', 8).update({
      selection: EditorSelection.range(6, 8),
    }).state;
    expect(isContinuationActive(state)).toBeNull();
  });
});
