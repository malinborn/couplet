// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { Strikethrough, Table } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';
import { isRenderedLink, linkReferenceLabels, normalizeLinkLabel } from './link-refs';
import { livePreviewPlugin } from './plugin';
import { LIVE_PREVIEW, flavourFacet } from './flavour';

const markdownExt = markdown({
  base: markdownLanguage,
  codeLanguages: languages,
  extensions: [Strikethrough, Table],
});

function makeState(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [markdownExt] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

/** Every `Link` node @lezer/markdown found, in document order. */
function linkNodes(state: EditorState): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'Link') found.push(node.node);
    },
  });
  return found;
}

/** Which of those the preview would actually render as links. */
function rendered(doc: string): string[] {
  const state = makeState(doc);
  return linkNodes(state)
    .filter((node) => isRenderedLink(state.doc, node))
    .map((node) => doc.slice(node.from, node.to));
}

describe('the bug: @lezer/markdown calls every bracket pair a Link', () => {
  it('is not md-mini inventing them — the parser really does emit these', () => {
    // Recorded so the fix is understood as "do not trust the node name",
    // not "the parser was fixed". All three are Link nodes in the tree.
    expect(linkNodes(makeState('see [1] and [2] refs')).length).toBe(2);
    expect(linkNodes(makeState('array[0] and dict["k"]')).length).toBe(2);
    expect(linkNodes(makeState('json: [\n  1,\n  2\n]')).length).toBe(1);
  });
});

describe('isRenderedLink — not a link', () => {
  it('a footnote-looking reference in prose', () => {
    expect(rendered('see [1] and [2] refs')).toEqual([]);
  });

  it('code-ish subscripts in prose', () => {
    expect(rendered('array[0] and dict["k"]')).toEqual([]);
  });

  it('the multi-line bracket pair from pretty-printed JSON (#47)', () => {
    expect(rendered('{\n  "list": [\n    1,\n    2\n  ]\n}')).toEqual([]);
  });

  it('an empty bracket pair', () => {
    expect(rendered('nothing here []')).toEqual([]);
  });

  it('a full reference whose label is not defined', () => {
    expect(rendered('[text][nope]')).toEqual([]);
  });

  it('a shortcut whose definition lives inside a fenced code block', () => {
    // The fence makes it code, not a definition. CommonMark agrees.
    expect(rendered('```\n[foo]: http://x.com\n```\n\n[foo]\n')).toEqual([]);
  });

  it('a label with a colon but no destination', () => {
    expect(rendered('[foo]:\n\n[foo]\n')).toEqual([]);
  });
});

describe('isRenderedLink — a real link', () => {
  it('an inline link', () => {
    expect(rendered('[docs](https://example.com)')).toEqual(['[docs](https://example.com)']);
  });

  it('an inline link with an empty destination, as toggleLink creates', () => {
    // `Cmd+K` inserts `[text]()` and opens the inspector; it must stay
    // rendered while the user types the URL.
    expect(rendered('[text]()')).toEqual(['[text]()']);
  });

  it('a shortcut reference with a definition', () => {
    expect(rendered('[foo]\n\n[foo]: http://x.com\n')).toEqual(['[foo]']);
  });

  it('a shortcut reference matched case-insensitively', () => {
    expect(rendered('[Foo]\n\n[FOO]: http://x.com\n')).toEqual(['[Foo]']);
  });

  it('a shortcut reference whose label wraps across a line', () => {
    expect(rendered('[a\nb]\n\n[a b]: /x\n')).toEqual(['[a\nb]']);
  });

  it('a full reference with a defined label', () => {
    expect(rendered('[text][bar]\n\n[bar]: /x\n')).toEqual(['[text][bar]']);
  });

  it('a collapsed reference, which uses its own text as the label', () => {
    expect(rendered('[foo][]\n\n[foo]: /x\n')).toEqual(['[foo][]']);
  });

  it('a definition whose destination is on the next line', () => {
    expect(rendered('[foo]\n\n[foo]:\nhttp://x.com\n')).toEqual(['[foo]']);
  });

  it('a definition with a title', () => {
    expect(rendered('[foo]\n\n[foo]: /a "Title"\n')).toEqual(['[foo]']);
  });

  it('a definition placed before its use', () => {
    expect(rendered('[foo]: /x\n\nuse [foo] here\n')).toEqual(['[foo]']);
  });
});

describe('linkReferenceLabels', () => {
  const labels = (doc: string) => [...linkReferenceLabels(Text.of(doc.split('\n')))].sort();

  it('collects and normalises', () => {
    expect(labels('[A  B]: /x\n[c]: /y\n')).toEqual(['a b', 'c']);
  });

  it('allows up to three spaces of indent and no more', () => {
    expect(labels('   [a]: /x\n')).toEqual(['a']);
    // Four spaces is an indented code block.
    expect(labels('    [b]: /x\n')).toEqual([]);
  });

  it('ignores definitions inside ``` and ~~~ fences', () => {
    expect(labels('```\n[a]: /x\n```\n[b]: /y\n')).toEqual(['b']);
    expect(labels('~~~\n[a]: /x\n~~~\n[b]: /y\n')).toEqual(['b']);
  });

  it('does not let a ~~~ line close a ``` fence', () => {
    expect(labels('```\n~~~\n[a]: /x\n```\n[b]: /y\n')).toEqual(['b']);
  });

  it('memoises per document instance', () => {
    const doc = Text.of(['[a]: /x']);
    expect(linkReferenceLabels(doc)).toBe(linkReferenceLabels(doc));
  });
});

describe('normalizeLinkLabel', () => {
  it('trims, collapses whitespace and case-folds', () => {
    expect(normalizeLinkLabel('  Foo\n  Bar  ')).toBe('foo bar');
  });
});

describe('what the preview actually draws', () => {
  /**
   * The decorations the live-preview plugin actually emits for `doc`.
   *
   * Two details the plugin insists on. The tree has to be parsed before the
   * view is constructed, because the plugin builds once in its constructor.
   * And the caret has to be off the lines under test: `live-preview` reveals
   * the raw markdown on the caret's own line, so a caret left at position 0
   * makes every decoration on the first line vanish — which looks exactly like
   * the fix working, for the wrong reason. Hence the parking line.
   */
  function decorationRanges(doc: string): Array<[number, number, string]> {
    const padded = `${doc}\n\npark the caret here`;
    const state = EditorState.create({
      doc: padded,
      selection: { anchor: padded.length },
      extensions: [markdownExt, flavourFacet.of(LIVE_PREVIEW), livePreviewPlugin],
    });
    ensureSyntaxTree(state, padded.length, 5000);
    const view = new EditorView({ state });
    const out: Array<[number, number, string]> = [];
    view.plugin(livePreviewPlugin)!.decorations.between(0, doc.length, (from, to, value) => {
      out.push([from, to, value.spec.class ?? 'replace']);
    });
    view.destroy();
    return out;
  }

  it('leaves `see [1] for details` completely alone', () => {
    // Before the fix both brackets were replaced and the text between them
    // marked `.cm-md-link`, so the line rendered as "see 1 for details".
    expect(decorationRanges('see [1] for details')).toEqual([]);
  });

  it('leaves a pretty-printed JSON array alone', () => {
    expect(decorationRanges('{\n  "l": [\n    1,\n    2\n  ]\n}')).toEqual([]);
  });

  it('still hides the syntax of a real inline link', () => {
    const ranges = decorationRanges('[docs](https://example.com)');
    expect(ranges).toContainEqual([0, 1, 'replace']);
    expect(ranges).toContainEqual([0, 27, 'cm-md-link']);
    expect(ranges).toContainEqual([5, 27, 'replace']);
  });

  it('still hides the syntax of a resolved reference link', () => {
    const doc = '[foo]\n\n[foo]: /x\n';
    const ranges = decorationRanges(doc);
    expect(ranges).toContainEqual([0, 1, 'replace']);
    expect(ranges).toContainEqual([0, 5, 'cm-md-link']);
  });

  it('renders formatting inside a bracket pair that is not a link', () => {
    // plugin.ts now descends when the Link is bogus, so the bold still works
    // and the brackets stay on screen as the characters they are.
    const ranges = decorationRanges('[**bold** text]');
    expect(ranges).toContainEqual([1, 3, 'replace']);
    expect(ranges).toContainEqual([1, 9, 'cm-md-bold']);
    expect(ranges).toContainEqual([7, 9, 'replace']);
    expect(ranges.some(([, , cls]) => cls === 'cm-md-link')).toBe(false);
  });
});
