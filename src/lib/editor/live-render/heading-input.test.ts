import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import { headingSpaceRedirect } from './heading-input';

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
    ],
  });
}

/** Apply the redirect (or a plain insert when it declines) and return the doc. */
function type(doc: string, cursor: number, insert: string): { doc: string; caret: number } {
  const state = makeState(doc, cursor);
  const spec = headingSpaceRedirect(state, cursor, cursor, insert);
  const next = state.update(
    spec ?? {
      changes: { from: cursor, to: cursor, insert },
      selection: EditorSelection.cursor(cursor + insert.length),
    }
  ).state;
  return { doc: next.doc.toString(), caret: next.selection.main.head };
}

describe('headingSpaceRedirect', () => {
  it('supplies the space inside a blockquote too', () => {
    expect(type('> #', 3, 'x')).toEqual({ doc: '> # x', caret: 5 });
    expect(type('> > ##', 6, 'x')).toEqual({ doc: '> > ## x', caret: 8 });
  });

  it('supplies the space that makes a single # a heading', () => {
    expect(type('#', 1, 'п')).toEqual({ doc: '# п', caret: 3 });
  });

  it('works for every heading level', () => {
    for (let level = 1; level <= 6; level++) {
      const hashes = '#'.repeat(level);
      expect(type(hashes, level, 'x')).toEqual({
        doc: `${hashes} x`,
        caret: level + 2,
      });
    }
  });

  it('leaves a further # alone, so the level can still be raised', () => {
    expect(type('#', 1, '#')).toEqual({ doc: '##', caret: 2 });
    expect(type('#####', 5, '#')).toEqual({ doc: '######', caret: 6 });
  });

  it('does not add a second space when one is already there', () => {
    expect(type('# привет', 1, 'x')).toEqual({ doc: '#x привет', caret: 2 });
  });

  it('declines beyond six hashes, which is not a heading', () => {
    expect(type('#######', 7, 'x')).toEqual({ doc: '#######x', caret: 8 });
  });

  it('still separates when the caret is inside the run', () => {
    // Ambiguous intent, so the rule is applied consistently: a character that
    // is not a hash gets a space. The alternative, declining, yields `#x#` —
    // not a heading at all — whereas this leaves a valid H1 whose text happens
    // to start with the leftover hash.
    expect(type('##', 1, 'x')).toEqual({ doc: '# x#', caret: 3 });
  });

  it('declines mid-line, where a hash is just a character', () => {
    expect(type('see #', 5, 'x')).toEqual({ doc: 'see #x', caret: 6 });
  });

  it('declines for whitespace, which already separates the run', () => {
    expect(type('#', 1, ' ')).toEqual({ doc: '# ', caret: 2 });
  });

  it('declines for a non-empty selection', () => {
    const state = makeState('#abc', 1);
    expect(headingSpaceRedirect(state, 1, 4, 'x')).toBeNull();
  });

  it('declines for multi-character input such as a paste', () => {
    const state = makeState('#', 1);
    expect(headingSpaceRedirect(state, 1, 1, 'привет')).toBeNull();
  });

  it('applies on a later line too', () => {
    expect(type('текст\n##', 8, 'з')).toEqual({ doc: 'текст\n## з', caret: 10 });
  });
});
