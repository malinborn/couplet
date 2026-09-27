import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import {
  computeCodeBlockExit,
  computeQuotedCodeNewline,
  computeFenceArrowTarget,
  fenceGeometryAt,
} from './code-block-exit';

// Same markdown config as setup.ts — the fence's parse shape (how many
// CodeMark children a terminated vs. unterminated block gets) depends on it.
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

/** Offset of the start of line `n` (1-based), plus `column`. */
function at(doc: string, n: number, column = 0): number {
  const lines = doc.split('\n');
  let off = 0;
  for (let i = 0; i < n - 1; i++) off += lines[i].length + 1;
  return off + column;
}

function applyExit(doc: string, pos: number): { doc: string; caret: number } | null {
  const state = makeState(doc, pos);
  const result = computeCodeBlockExit(state);
  if (!result) return null;
  const next = state.update({
    changes: result.changes,
    selection: EditorSelection.cursor(result.caret),
  }).state;
  return { doc: next.doc.toString(), caret: next.selection.main.head };
}

/** The document with a `|` drawn where the caret ended up. */
function rendered(result: { doc: string; caret: number }): string {
  return result.doc.slice(0, result.caret) + '|' + result.doc.slice(result.caret);
}

describe('fenceGeometryAt', () => {
  it('reports the fence lines of a terminated block', () => {
    const doc = 'para\n\n```js\na\nb\n```\n\nafter\n';
    const geo = fenceGeometryAt(makeState(doc, at(doc, 4)), at(doc, 4));
    expect(geo).toEqual({ openLine: 3, closeLine: 6, firstContent: 4, lastContent: 5 });
  });

  it('returns null for an unterminated fence — there is nothing to exit into', () => {
    const doc = '```js\na\n';
    expect(fenceGeometryAt(makeState(doc, at(doc, 2)), at(doc, 2))).toBeNull();
  });

  it('returns null outside a code block', () => {
    const doc = 'plain text\n';
    expect(fenceGeometryAt(makeState(doc, 3), 3)).toBeNull();
  });
});

describe('computeCodeBlockExit — when it does nothing', () => {
  it('leaves a blank line in the middle of the block alone', () => {
    // The trap the rule exists for: a blank line between two functions must be
    // reachable with the plain Enter key.
    const doc = '```js\nfunction a() {}\n\nfunction b() {}\n```\n';
    expect(applyExit(doc, at(doc, 3))).toBeNull();
  });

  it('does nothing on a non-blank last content line', () => {
    const doc = '```js\na\nb\n```\n';
    expect(applyExit(doc, at(doc, 3, 1))).toBeNull();
  });

  it('does nothing on the only content line of a freshly inserted fence', () => {
    // Otherwise a just-created empty block would eject on the very first Enter.
    const doc = '```js\n\n```\n';
    expect(applyExit(doc, at(doc, 2))).toBeNull();
  });

  it('does nothing inside an unterminated fence', () => {
    const doc = '```js\na\n\n';
    expect(applyExit(doc, at(doc, 3))).toBeNull();
  });

  it('does nothing outside a code block', () => {
    const doc = 'a\n\n';
    expect(applyExit(doc, at(doc, 2))).toBeNull();
  });

  it('does nothing with a non-empty selection', () => {
    const doc = '```js\na\n\n```\n';
    const state = EditorState.create({
      doc,
      selection: { anchor: at(doc, 2), head: at(doc, 3) },
      extensions: [markdown({ base: markdownLanguage, extensions: [Strikethrough, Table] })],
    });
    expect(computeCodeBlockExit(state)).toBeNull();
  });
});

describe('computeCodeBlockExit — the exit', () => {
  it('drops the escape line and opens a fresh one below the block', () => {
    const doc = 'intro\n\n```js\nconst a = 1;\n\n```\nafter\n';
    expect(rendered(applyExit(doc, at(doc, 5))!)).toBe(
      'intro\n\n```js\nconst a = 1;\n```\n|\nafter\n'
    );
  });

  it('appends a line when the block ends the file', () => {
    const doc = '```js\nconst a = 1;\n\n```';
    expect(rendered(applyExit(doc, at(doc, 3))!)).toBe('```js\nconst a = 1;\n```\n|');
  });

  it('reuses an empty line that already follows the block', () => {
    const doc = '```js\na\n\n```\n\nafter\n';
    expect(rendered(applyExit(doc, at(doc, 3))!)).toBe('```js\na\n```\n|\nafter\n');
  });

  it('keeps a trailing blank line the user authored with Shift+Enter', () => {
    // Only the line the caret sits on is consumed, so a deliberate blank at the
    // end of the code survives the exit.
    const doc = '```js\na\n\n\n```\n';
    expect(rendered(applyExit(doc, at(doc, 4))!)).toBe('```js\na\n\n```\n|');
  });

  it('treats a whitespace-only line as an escape line', () => {
    const doc = '```py\ndef f():\n    \n```\n';
    expect(rendered(applyExit(doc, at(doc, 3, 4))!)).toBe('```py\ndef f():\n```\n|');
  });

  it('exits a long block from its end', () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const doc = '```\n' + body + '\n\n```\n';
    const result = applyExit(doc, at(doc, 32))!;
    expect(result.doc).toBe('```\n' + body + '\n```\n');
    expect(result.caret).toBe(result.doc.length);
  });
});

describe('computeFenceArrowTarget', () => {
  const doc = 'before\n```js\na\nbb\n```\nafter\n';

  it('moves past the closing fence from the last content line, keeping the column', () => {
    const target = computeFenceArrowTarget(makeState(doc, at(doc, 4, 1)), true);
    expect(target).toBe(at(doc, 6, 1));
  });

  it('moves past the opening fence from the first content line', () => {
    const target = computeFenceArrowTarget(makeState(doc, at(doc, 3, 1)), false);
    expect(target).toBe(at(doc, 1, 1));
  });

  it('clamps the column to a shorter target line', () => {
    const short = 'ab\n```\nlonger line\n```\nx\n';
    expect(computeFenceArrowTarget(makeState(short, at(short, 3, 9)), true)).toBe(at(short, 5, 1));
  });

  it('passes on a content line that is neither first nor last', () => {
    const tall = '```\na\nb\nc\n```\nx\n';
    expect(computeFenceArrowTarget(makeState(tall, at(tall, 3)), true)).toBe('pass');
  });

  it('reports blocked when the block ends the document', () => {
    const last = 'x\n```\na\n```';
    expect(computeFenceArrowTarget(makeState(last, at(last, 3)), true)).toBe('blocked');
  });

  it('reports blocked when the block opens the document', () => {
    const first = '```\na\n```\nx\n';
    expect(computeFenceArrowTarget(makeState(first, at(first, 2)), false)).toBe('blocked');
  });

  it('passes outside a code block', () => {
    expect(computeFenceArrowTarget(makeState(doc, 2), true)).toBe('pass');
  });
});

describe('computeQuotedCodeNewline — Enter in a code block inside a quote', () => {
  function enter(doc: string, pos: number): string | null {
    const state = makeState(doc, pos);
    const result = computeQuotedCodeNewline(state);
    if (!result) return null;
    const next = state.update({
      changes: result.changes,
      selection: EditorSelection.cursor(result.caret),
    }).state;
    return rendered({ doc: next.doc.toString(), caret: next.selection.main.head });
  }

  const doc = ['> ```js', '> a1', '>   b2', '> ```', '> after'].join('\n');

  it('continues the quote prefix, so the fence is not closed early', () => {
    expect(enter(doc, at(doc, 2, 4))).toBe(
      ['> ```js', '> a1', '> |', '>   b2', '> ```', '> after'].join('\n')
    );
  });

  it("keeps the code's own indentation", () => {
    expect(enter(doc, at(doc, 3, 6))).toBe(
      ['> ```js', '> a1', '>   b2', '>   |', '> ```', '> after'].join('\n')
    );
  });

  it('adds one level per enclosing quote and no more', () => {
    const nested = ['> > ```', '> > > x', '> > ```'].join('\n');
    expect(enter(nested, at(nested, 2, 7))).toBe(['> > ```', '> > > x', '> > |', '> > ```'].join('\n'));
  });

  // In live-render the line start is a legal caret stop (Home, or ArrowLeft
  // over the hidden prefix). A bare newline there ended the quote.
  it('at the line start, before the hidden prefix, adds a prefixed line above', () => {
    expect(enter(doc, at(doc, 2, 0))).toBe(
      ['> ```js', '>', '|> a1', '>   b2', '> ```', '> after'].join('\n')
    );
    expect(enter(doc, at(doc, 2, 1))).toBe(
      ['> ```js', '>', '>| a1', '>   b2', '> ```', '> after'].join('\n')
    );
    expect(enter(doc, at(doc, 4, 0))).toBe(
      ['> ```js', '> a1', '>   b2', '>', '|> ```', '> after'].join('\n')
    );
    const nested = ['> > ```', '> > x', '> > ```'].join('\n');
    expect(enter(nested, at(nested, 2, 0))).toBe(['> > ```', '> >', '|> > x', '> > ```'].join('\n'));
  });

  it('continues the prefix when the opening fence line is split', () => {
    expect(enter(doc, at(doc, 1, 6))).toBe(['> ```j', '> |s', '> a1', '>   b2', '> ```', '> after'].join('\n'));
  });

  it('leaves the end of the opening fence line to the fence auto-close', () => {
    expect(enter(doc, at(doc, 1, 7))).toBeNull();
    const open = '> ```js';
    expect(enter(open, open.length)).toBeNull();
  });

  it('declines on the fence lines and outside quotes', () => {
    expect(enter(doc, at(doc, 4, 5))).toBeNull();
    const plain = ['```js', 'a1', '```'].join('\n');
    expect(enter(plain, at(plain, 2, 2))).toBeNull();
  });
});
