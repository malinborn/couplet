import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import {
  detectInspectorTarget,
  setLinkUrl,
  removeLink,
  setFenceLang,
  type LinkTarget,
  type FenceTarget,
} from './inspector-model';

// Mirrors the markdown() config assembled in setup.ts:44-48, so the syntax
// tree shape matches production exactly (GFM — including Task lists — comes
// bundled with markdownLanguage; Strikethrough/Table are added explicitly).
function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: [Strikethrough, Table],
      }),
    ],
  });
}

function applyTo(state: EditorState, spec: ReturnType<typeof setLinkUrl>): string {
  return state.update(spec).state.doc.toString();
}

describe('detectInspectorTarget — link', () => {
  const doc = '[text](url)\n';
  // Link spans [0,11): '[' text ']' '(' url ')'
  //   text  -> [1,5)
  //   url   -> [7,10)

  it('detects with caret inside the text', () => {
    const target = detectInspectorTarget(makeState(doc), 3);
    expect(target?.kind).toBe('link');
    const link = target as LinkTarget;
    expect(link.text).toEqual({ from: 1, to: 5 });
    expect(link.url).toEqual({ from: 7, to: 10 });
    expect(link).toEqual(
      expect.objectContaining({ kind: 'link', from: 0, to: 11 })
    );
  });

  it('detects with caret inside the url', () => {
    const target = detectInspectorTarget(makeState(doc), 8);
    expect(target?.kind).toBe('link');
    expect((target as LinkTarget).url).toEqual({ from: 7, to: 10 });
  });

  it('detects at the opening boundary (pos === from)', () => {
    const target = detectInspectorTarget(makeState(doc), 0);
    expect(target?.kind).toBe('link');
    expect(target).toEqual(expect.objectContaining({ from: 0, to: 11 }));
  });

  it('detects at the closing boundary (pos === to)', () => {
    const target = detectInspectorTarget(makeState(doc), 11);
    expect(target?.kind).toBe('link');
    expect(target).toEqual(expect.objectContaining({ from: 0, to: 11 }));
  });

  it('handles an empty URL — [text]()', () => {
    const emptyDoc = '[text]()\n';
    const target = detectInspectorTarget(makeState(emptyDoc), 7);
    expect(target?.kind).toBe('link');
    const link = target as LinkTarget;
    expect(link.url.from).toBe(link.url.to); // zero-width
    expect(link.text).toEqual({ from: 1, to: 5 });
  });

  it('excludes the GFM checkbox — "- [x] done" is a Task, not a Link', () => {
    // Confirmed empirically against this project's exact markdown() config:
    // markdownLanguage already bundles GFM (task lists included), so
    // "[x]" parses as Task > TaskMarker, never as a Link node. No special
    // exclusion logic is needed in detectInspectorTarget — walking up from
    // any position inside "[x]" simply never reaches a Link.
    const checkboxDoc = '- [x] done\n';
    for (let pos = 2; pos <= 5; pos++) {
      expect(detectInspectorTarget(makeState(checkboxDoc), pos)).toBeNull();
    }
    const uncheckedDoc = '- [ ] todo\n';
    for (let pos = 2; pos <= 5; pos++) {
      expect(detectInspectorTarget(makeState(uncheckedDoc), pos)).toBeNull();
    }
  });

  it('edits the destination of a link whose text is a URL', () => {
    const urlDoc = '[https://a.test](https://b.test)\n';
    const link = detectInspectorTarget(makeState(urlDoc), 3) as LinkTarget;
    expect(urlDoc.slice(link.url.from, link.url.to)).toBe('https://b.test');
  });

  it('stays out of a [[ picker query — the picker owns it (file-links D5)', () => {
    // Lezer reads `[[pl]]` as a Link (shortcut reference); with the caret
    // in the query the URL panel would cover the picker's popup.
    expect(detectInspectorTarget(makeState('[[pl]]\n'), 4)).toBeNull();
    expect(detectInspectorTarget(makeState('see [[]]\n'), 6)).toBeNull();
    expect(detectInspectorTarget(makeState('[[pl]] [text](url)\n'), 9)?.kind).toBe('link');
  });

  it('returns null for a position outside any link', () => {
    expect(detectInspectorTarget(makeState('plain text\n'), 3)).toBeNull();
  });
});

describe('detectInspectorTarget — fenced code', () => {
  it('detects with an info string, exposing its exact range', () => {
    const doc = '```js\ncode\n```\n';
    // CodeMark [0,3), CodeInfo [3,5) "js"
    const target = detectInspectorTarget(makeState(doc), 4);
    expect(target?.kind).toBe('fence');
    const fence = target as FenceTarget;
    expect(fence.lang).toEqual({ from: 3, to: 5 });
    expect(fence).toEqual(expect.objectContaining({ from: 0, to: 14 }));
  });

  it('detects without an info string, lang range is zero-width right after the fence', () => {
    const doc = '```\ncode\n```\n';
    // CodeMark [0,3)
    const target = detectInspectorTarget(makeState(doc), 6);
    expect(target?.kind).toBe('fence');
    const fence = target as FenceTarget;
    expect(fence.lang).toEqual({ from: 3, to: 3 });
  });

  it('detects at the opening boundary (pos === from)', () => {
    const doc = '```js\ncode\n```\n';
    const target = detectInspectorTarget(makeState(doc), 0);
    expect(target?.kind).toBe('fence');
  });

  it('detects at the closing boundary (pos === to)', () => {
    const doc = '```js\ncode\n```\n';
    const target = detectInspectorTarget(makeState(doc), 14);
    expect(target?.kind).toBe('fence');
  });

  it('returns null for an indented code block (not fenced)', () => {
    const doc = '    code\n';
    expect(detectInspectorTarget(makeState(doc), 5)).toBeNull();
  });
});

describe('setLinkUrl', () => {
  it('replaces an existing url', () => {
    const doc = '[text](old)\n';
    const state = makeState(doc);
    const target = detectInspectorTarget(state, 8) as LinkTarget;
    expect(applyTo(state, setLinkUrl(state, target, 'https://example.com'))).toBe(
      '[text](https://example.com)\n'
    );
  });

  it('inserts into a previously empty url', () => {
    const doc = '[text]()\n';
    const state = makeState(doc);
    const target = detectInspectorTarget(state, 7) as LinkTarget;
    expect(applyTo(state, setLinkUrl(state, target, 'https://example.com'))).toBe(
      '[text](https://example.com)\n'
    );
  });

  it('clears a url back to empty', () => {
    const doc = '[text](old)\n';
    const state = makeState(doc);
    const target = detectInspectorTarget(state, 8) as LinkTarget;
    expect(applyTo(state, setLinkUrl(state, target, ''))).toBe('[text]()\n');
  });
});

describe('removeLink', () => {
  it('unwraps [text](url) to bare text', () => {
    const doc = 'see [text](url) here\n';
    const state = makeState(doc);
    const target = detectInspectorTarget(state, 8) as LinkTarget;
    expect(applyTo(state, removeLink(state, target))).toBe('see text here\n');
  });

  it('unwraps an empty-url link the same way', () => {
    const doc = '[text]()\n';
    const state = makeState(doc);
    const target = detectInspectorTarget(state, 3) as LinkTarget;
    expect(applyTo(state, removeLink(state, target))).toBe('text\n');
  });
});

describe('setFenceLang', () => {
  it('replaces an existing info string', () => {
    const doc = '```js\ncode\n```\n';
    const state = makeState(doc);
    const target = detectInspectorTarget(state, 4) as FenceTarget;
    expect(applyTo(state, setFenceLang(state, target, 'python'))).toBe(
      '```python\ncode\n```\n'
    );
  });

  it('inserts an info string where none existed', () => {
    const doc = '```\ncode\n```\n';
    const state = makeState(doc);
    const target = detectInspectorTarget(state, 1) as FenceTarget;
    expect(applyTo(state, setFenceLang(state, target, 'rust'))).toBe(
      '```rust\ncode\n```\n'
    );
  });

  it('clears an existing info string down to a bare fence', () => {
    const doc = '```js\ncode\n```\n';
    const state = makeState(doc);
    const target = detectInspectorTarget(state, 4) as FenceTarget;
    expect(applyTo(state, setFenceLang(state, target, ''))).toBe('```\ncode\n```\n');
  });

  it('trims surrounding whitespace from the new lang', () => {
    const doc = '```\ncode\n```\n';
    const state = makeState(doc);
    const target = detectInspectorTarget(state, 1) as FenceTarget;
    expect(applyTo(state, setFenceLang(state, target, '  ts  '))).toBe(
      '```ts\ncode\n```\n'
    );
  });
});
