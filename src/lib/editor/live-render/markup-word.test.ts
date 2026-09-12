import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import { markupModelField } from './atomic';
import { visibleGroupTarget, hiddenInRange } from './markup-word';

function makeState(doc: string, cursor = 0): EditorState {
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
    ],
  });
}

// `Абзац с **жирным** словом.`
//  0-4 Абзац | 5 ␣ | 6 с | 7 ␣ | 8-9 ** | 10-15 жирным | 16-17 ** | 18 ␣ | 19-24 словом | 25 .
const BOLD = 'Абзац с **жирным** словом.';

describe('visibleGroupTarget — the two offsets must answer identically', () => {
  const state = makeState(BOLD);

  it('jumps to the start of the word from the OUTER offset (the bug: it stopped at 16)', () => {
    expect(visibleGroupTarget(state, 18, false)).toBe(10);
  });

  it('and from the INNER offset, which already worked', () => {
    expect(visibleGroupTarget(state, 16, false)).toBe(10);
  });

  it('the two agree — which is the whole requirement of #73', () => {
    expect(visibleGroupTarget(state, 18, false)).toBe(visibleGroupTarget(state, 16, false));
    expect(visibleGroupTarget(state, 18, true)).toBe(visibleGroupTarget(state, 16, true));
  });

  it('crosses the opening marker forward (the bug: it stopped at 10)', () => {
    expect(visibleGroupTarget(state, 8, true)).toBe(16);
  });

  it('takes the space and the following word going forward out of a span', () => {
    expect(visibleGroupTarget(state, 16, true)).toBe(25);
    expect(visibleGroupTarget(state, 18, true)).toBe(25);
  });

  it('lands INSIDE the span at the content start, not outside the opening marker', () => {
    // 8 and 10 paint at the same pixel; 10 is where a click just before the
    // word lands, and the one that keeps typing bold. Tracking `landing`
    // separately from the scan position is what produces 10 rather than 8.
    expect(visibleGroupTarget(state, 18, false)).toBe(10);
  });

  it('keeps walking past the span into ordinary prose', () => {
    expect(visibleGroupTarget(state, 10, false)).toBe(6);
  });
});

describe('visibleGroupTarget — two adjacent spans', () => {
  // `**один** *два*`: 0-1 ** | 2-5 один | 6-7 ** | 8 ␣ | 9 * | 10-12 два | 13 *
  const state = makeState('**один** *два*');

  it('crosses the space and the next span\'s opening marker in one jump', () => {
    expect(visibleGroupTarget(state, 8, true)).toBe(13);
  });

  it('comes back to the start of the second word from either offset', () => {
    expect(visibleGroupTarget(state, 14, false)).toBe(10);
    expect(visibleGroupTarget(state, 13, false)).toBe(10);
  });
});

describe('visibleGroupTarget — hidden things that are not emphasis pairs', () => {
  it('steps over a whole `](url)`, which is hidden as one span wider than any LinkMark', () => {
    // `см [текст](http://a.b) тут`: 3 [ | 4-8 текст | 9..21 ](http://a.b) | 22 ␣
    const state = makeState('см [текст](http://a.b) тут');
    expect(visibleGroupTarget(state, 22, false)).toBe(4);
  });

  it('steps over a hidden list bullet', () => {
    // `- пункт списка`: 0 - | 1 ␣ | 2-6 пункт
    const state = makeState('- пункт списка');
    expect(visibleGroupTarget(state, 7, false)).toBe(2);
  });
});

describe('visibleGroupTarget — plain prose is scanned exactly like CM6 does', () => {
  const state = makeState('Абзац с простым словом.');
  //                       0-4    5 6 7 8-14    15 16-21  22

  it('backward to the start of the current word', () => {
    expect(visibleGroupTarget(state, 15, false)).toBe(8);
  });

  it('forward takes a single leading space plus the word after it', () => {
    expect(visibleGroupTarget(state, 7, true)).toBe(15);
  });

  it('stops at a category change rather than running through punctuation', () => {
    expect(visibleGroupTarget(state, 16, true)).toBe(22);
  });
});

describe('hiddenInRange — the gate that hands bidi-correct motion back to CM6', () => {
  const state = makeState(BOLD);

  it('is true when a marker lies in the path', () => {
    expect(hiddenInRange(state, 10, 18)).toBe(true); // closing marker 16..18
    expect(hiddenInRange(state, 8, 16)).toBe(true); // opening marker 8..10
  });

  it('is false when the jump stays inside the content, so the default command runs', () => {
    expect(hiddenInRange(state, 10, 16)).toBe(false);
  });

  it('is false in plain prose, which is why nothing about normal text changes', () => {
    const plain = makeState('Абзац с простым словом.');
    expect(hiddenInRange(plain, 0, 23)).toBe(false);
  });

  it('is false for an empty or inverted range', () => {
    expect(hiddenInRange(state, 12, 12)).toBe(false);
    expect(hiddenInRange(state, 18, 10)).toBe(false);
  });
});
