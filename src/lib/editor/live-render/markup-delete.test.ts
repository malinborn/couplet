import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import { markupPairs } from './atomic';
import { visibleDeleteRange } from './markup-delete';

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, Table] }),
    ],
  });
}

/** The document after the key press, or `null` when the default command would handle it. */
function press(doc: string, pos: number, forward: boolean): string | null {
  const state = makeState(doc);
  const range = visibleDeleteRange(state, markupPairs(state), pos, forward);
  if (!range) return null;
  return state.update({ changes: { ...range, insert: '' } }).state.doc.toString();
}

const DOC = 'Абзац с **жирным** словом.';
// Offsets: `**` 8..10, `жирным` 10..16, `**` 16..18.

describe('visibleDeleteRange — the character next to the caret on screen', () => {
  it('Backspace just past the closing marker deletes the last content character', () => {
    expect(press(DOC, 18, false)).toBe('Абзац с **жирны** словом.');
  });

  it('Backspace at the content start deletes the character before the span', () => {
    // Visually the caret sits right before `ж`; the previous visible character
    // is the space, which is outside the bold.
    expect(press(DOC, 10, false)).toBe('Абзац с**жирным** словом.');
  });

  it('Delete at the content end deletes the character after the span', () => {
    expect(press(DOC, 16, true)).toBe('Абзац с **жирным**словом.');
  });

  it('Delete before the opening marker deletes the first content character', () => {
    expect(press(DOC, 8, true)).toBe('Абзац с **ирным** словом.');
  });

  it('the two offsets that print at one pixel agree on what to delete', () => {
    // 16 and 18 are the same point on screen. Backspace there must mean the
    // same thing from either; 16 falls through to the default command, which
    // deletes exactly the character this one would.
    expect(press(DOC, 16, false)).toBeNull();
    expect(press(DOC, 18, false)).toBe('Абзац с **жирны** словом.');
    // And forward, from either of 8 and 10.
    expect(press(DOC, 10, true)).toBeNull();
    expect(press(DOC, 8, true)).toBe('Абзац с **ирным** словом.');
  });
});

describe('visibleDeleteRange — emptying a span takes the pair', () => {
  it('removes both markers rather than leaving ****', () => {
    expect(press('Абзац с **ж** словом.', 13, false)).toBe('Абзац с  словом.');
  });

  it('cascades through nested spans', () => {
    expect(press('Текст ***о*** дальше.', 13, false)).toBe('Текст  дальше.');
  });
});

describe('visibleDeleteRange — other span kinds', () => {
  it('inline code', () => {
    expect(press('Тут `код` дальше.', 9, false)).toBe('Тут `ко` дальше.');
  });

  it('strikethrough', () => {
    expect(press('Текст ~~нет~~ дальше.', 13, false)).toBe('Текст ~~не~~ дальше.');
  });

  it('a link deletes its last text character, keeping the target intact', () => {
    expect(press('см. [текст](https://x.dev) далее', 26, false)).toBe(
      'см. [текс](https://x.dev) далее'
    );
  });

  it('nested spans: the caret steps over both closing markers', () => {
    expect(press('Текст ***оба*** дальше.', 15, false)).toBe('Текст ***об*** дальше.');
  });
});

describe('visibleDeleteRange — declines, leaving the default command in charge', () => {
  it('inside the content', () => {
    expect(press(DOC, 13, false)).toBeNull();
    expect(press(DOC, 13, true)).toBeNull();
  });

  it('nowhere near a span', () => {
    expect(press(DOC, 4, false)).toBeNull();
    expect(press(DOC, 22, true)).toBeNull();
  });

  it('in a document with no spans at all', () => {
    expect(press('просто текст', 5, false)).toBeNull();
  });

  it('at the very start and end of the document', () => {
    expect(press('**bold**', 0, false)).toBeNull();
    expect(press('**bold**', 8, true)).toBeNull();
  });

  it('when the visible neighbour is on another line, so line joining stays default', () => {
    // `**bold**` opens the second line: stepping back over the opening marker
    // lands on the line start, and joining lines is the default command's job —
    // it knows about list markers and indentation, and this does not.
    expect(press('первая\n**bold** x', 9, false)).toBeNull();
  });
});
