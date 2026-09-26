import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';

// `markupPairs` walks the whole tree. Backspace runs `computeBlockFormatRemoval`
// on every press, so that walk must stay off the ordinary path.
vi.mock('./atomic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomic')>();
  return { ...actual, markupPairs: vi.fn(actual.markupPairs) };
});

const { markupPairs, liveRenderAtomic } = await import('./atomic');
const { computeBlockFormatRemoval } = await import('./block-format');

function makeState(doc: string, pos: number, withModel: boolean): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [
      markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, Table] }),
      ...(withModel ? liveRenderAtomic : []),
    ],
  });
}

describe('computeBlockFormatRemoval — cost of the content-start check', () => {
  beforeEach(() => {
    vi.mocked(markupPairs).mockClear();
  });

  it('does not walk the tree for a Backspace in the middle of a quoted or listed line', () => {
    computeBlockFormatRemoval(makeState('> some quoted text\n', 9, false));
    computeBlockFormatRemoval(makeState('- some item text\n', 7, false));
    computeBlockFormatRemoval(makeState('> - some item text\n', 9, false));
    expect(markupPairs).not.toHaveBeenCalled();
  });

  it('reads the cached model when live-render installed it', () => {
    const state = makeState('> **bold** x\n', 4, true);
    expect(computeBlockFormatRemoval(state)).not.toBeNull();
    expect(markupPairs).not.toHaveBeenCalled();
  });
});
