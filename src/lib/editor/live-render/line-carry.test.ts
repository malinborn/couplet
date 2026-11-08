// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { insertNewlineAndIndent } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import { liveRenderAtomic } from './atomic';
import { markupRepairFilter } from './markup-repair';
import { markupWhitespaceFilter } from './markup-whitespace';
import {
  activeFormatsAt,
  continuationEscapeSpec,
  continuationFormatKeySpec,
  inlineContinuation,
  newlineKeepingFormat,
} from './inline-continuation';
import { carriedFormatAt } from './line-carry';

// The order `liveRenderExtensions()` registers them in — the filters run in
// reverse, so repair → whitespace guard → caret normalise.
function makeView(doc: string, cursor: number): EditorView {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, Table] }),
        ...liveRenderAtomic,
        markupWhitespaceFilter,
        markupRepairFilter,
        inlineContinuation(),
      ],
    }),
  });
}

/** Types `text` the way a key does: every input handler first, then CM6's own insertion. */
function type(view: EditorView, text: string): void {
  const { from, to } = view.state.selection.main;
  const insert = () =>
    view.state.update({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length) });
  for (const handler of view.state.facet(EditorView.inputHandler)) {
    if (handler(view, from, to, text, insert)) return;
  }
  view.dispatch(insert());
}

function withCaret(view: EditorView): string {
  const head = view.state.selection.main.head;
  return view.state.sliceDoc(0, head) + '|' + view.state.sliceDoc(head);
}

const LINES = 'верх\n**жирная строка**\nниз';
// `**` 5..7, `жирная строка` 7..20, `**` 20..22.

let views: EditorView[] = [];
function view(doc: string, cursor: number): EditorView {
  const v = makeView(doc, cursor);
  views.push(v);
  return v;
}
afterEach(() => {
  views.forEach((v) => v.destroy());
  views = [];
});

describe('Enter at the end of a bold line', () => {
  it('moves the caret to the new line, plain', () => {
    const v = view(LINES, 20);
    expect(activeFormatsAt(v.state)).toEqual(['strong']);
    insertNewlineAndIndent(v);
    expect(withCaret(v)).toBe('верх\n**жирная строка**\n|\nниз');
    expect(activeFormatsAt(v.state)).toEqual([]);
    type(v, 'т');
    expect(v.state.doc.toString()).toBe('верх\n**жирная строка**\nт\nниз');
  });
});

describe('Shift+Enter keeps the format on the new line', () => {
  it('at the end of a bold line: plain document, bold caret, bold first character', () => {
    const v = view(LINES, 20);
    expect(newlineKeepingFormat(v)).toBe(true);
    // Nothing written for the format yet — no `****` to leave behind.
    expect(withCaret(v)).toBe('верх\n**жирная строка**\n|\nниз');
    expect(activeFormatsAt(v.state)).toEqual(['strong']);

    type(v, 'т');
    expect(withCaret(v)).toBe('верх\n**жирная строка**\n**т|**\nниз');
    type(v, 'екст');
    expect(v.state.doc.toString()).toBe('верх\n**жирная строка**\n**текст**\nниз');
    expect(activeFormatsAt(v.state)).toEqual(['strong']);
  });

  it('keeps the original markers and every nested format', () => {
    const v = view('***оба***', 6);
    newlineKeepingFormat(v);
    expect(activeFormatsAt(v.state).sort()).toEqual(['emphasis', 'strong']);
    type(v, 'х');
    expect(v.state.doc.toString()).toBe('***оба***\n***х***');

    const u = view('__жир__', 5);
    newlineKeepingFormat(u);
    type(u, 'х');
    expect(u.state.doc.toString()).toBe('__жир__\n__х__');
  });

  it('a space first stays plain and the carry waits for the first real character', () => {
    const v = view(LINES, 20);
    newlineKeepingFormat(v);
    type(v, ' ');
    expect(activeFormatsAt(v.state)).toEqual(['strong']);
    type(v, 'т');
    expect(v.state.doc.toString()).toBe('верх\n**жирная строка**\n **т**\nниз');
  });

  it('in the middle of a span it is a plain split — the second half is already bold', () => {
    const v = view(LINES, 10);
    newlineKeepingFormat(v);
    expect(withCaret(v)).toBe('верх\n**жир**\n**|ная строка**\nниз');
    expect(carriedFormatAt(v.state, v.state.selection.main.head)).toBeNull();
  });

  it('a second Shift+Enter on the still empty line carries the format on', () => {
    const v = view(LINES, 20);
    newlineKeepingFormat(v);
    newlineKeepingFormat(v);
    type(v, 'т');
    expect(v.state.doc.toString()).toBe('верх\n**жирная строка**\n\n**т**\nниз');
  });

  it('a markdown marker typed first is not wrapped — it ends the carry', () => {
    for (const ch of ['*', '-', '#', '>', '`']) {
      const v = view(LINES, 20);
      newlineKeepingFormat(v);
      type(v, ch);
      expect(v.state.doc.toString()).toBe(`верх\n**жирная строка**\n${ch}\nниз`);
      expect(activeFormatsAt(v.state)).toEqual([]);
    }
  });

  it('does nothing special where no format is active', () => {
    expect(newlineKeepingFormat(view(LINES, 22))).toBe(false);
    expect(newlineKeepingFormat(view('просто', 6))).toBe(false);
  });
});

describe('the carried format ends without touching the document', () => {
  it('on Escape', () => {
    const v = view(LINES, 20);
    newlineKeepingFormat(v);
    v.dispatch(continuationEscapeSpec(v.state)!);
    expect(activeFormatsAt(v.state)).toEqual([]);
    type(v, 'т');
    expect(v.state.doc.toString()).toBe('верх\n**жирная строка**\nт\nниз');
  });

  it('on the matching format key, one layer at a time', () => {
    const v = view('***оба***', 6);
    newlineKeepingFormat(v);
    v.dispatch(continuationFormatKeySpec(v.state, 'strong')!);
    expect(activeFormatsAt(v.state)).toEqual(['emphasis']);
    type(v, 'х');
    expect(v.state.doc.toString()).toBe('***оба***\n*х*');
  });

  it('another format key adds its format to the carry instead of writing an empty pair', () => {
    const v = view(LINES, 20);
    newlineKeepingFormat(v);
    v.dispatch(continuationFormatKeySpec(v.state, 'emphasis')!);
    expect(v.state.doc.toString()).toBe('верх\n**жирная строка**\n\nниз');
    expect(activeFormatsAt(v.state).sort()).toEqual(['emphasis', 'strong']);
    type(v, 'х');
    expect(v.state.doc.toString()).toBe('верх\n**жирная строка**\n***х***\nниз');
  });

  it('when the caret moves away', () => {
    const v = view(LINES, 20);
    newlineKeepingFormat(v);
    v.dispatch({ selection: EditorSelection.cursor(2) });
    v.dispatch({ selection: EditorSelection.cursor(23) });
    expect(activeFormatsAt(v.state)).toEqual([]);
  });
});
