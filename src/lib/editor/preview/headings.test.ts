import { describe, it, expect } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { Strikethrough, Table } from '@lezer/markdown';
import type { Decoration, EditorView } from '@codemirror/view';
import { decorateHeading } from './headings';
import { flavourFacet, LIVE_RENDER } from './flavour';

function makeState(doc: string, anchor = 0, extra: Extension[] = []): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [
      ...extra,
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: [Strikethrough, Table],
      }),
    ],
  });
}

/**
 * Mirror of plugin.ts iteration logic: returns names of every node visited
 * by the live-preview iterator. Used to detect whether inline children of
 * a heading are reachable (i.e. whether the iterator descends into them).
 */
function visitedNodeNames(state: EditorState): string[] {
  const visited: string[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      visited.push(node.name);
      switch (node.name) {
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6':
          // Mirror plugin.ts: descend so inline children get decorated.
          break;
        case 'Emphasis':
        case 'StrongEmphasis':
        case 'Strikethrough':
        case 'InlineCode':
        case 'Link':
        case 'FencedCode':
        case 'Table':
        case 'HorizontalRule':
        case 'Blockquote':
          return false;
        case 'ListItem':
          break;
      }
    },
  });
  return visited;
}

describe('heading inline children', () => {
  it('parser produces InlineCode as child of ATXHeading', () => {
    const state = makeState('## Run timer from `Task` when sync\n');
    const tree = syntaxTree(state);

    let foundInlineCodeInHeading = false;
    tree.iterate({
      enter(node) {
        if (
          node.name === 'ATXHeading1' ||
          node.name === 'ATXHeading2' ||
          node.name === 'ATXHeading3'
        ) {
          const cursor = node.node.cursor();
          if (cursor.firstChild()) {
            do {
              if (cursor.name === 'InlineCode') {
                foundInlineCodeInHeading = true;
              }
            } while (cursor.nextSibling());
          }
        }
      },
    });

    expect(foundInlineCodeInHeading).toBe(true);
  });

  it('iterator descends into heading children so InlineCode is reachable', () => {
    const state = makeState('## Run timer from `Task` when sync\n');
    const visited = visitedNodeNames(state);
    expect(visited).toContain('ATXHeading2');
    // The bug: if heading case returns false, InlineCode is never visited
    // and therefore never decorated. After fix, InlineCode must appear.
    expect(visited).toContain('InlineCode');
  });

  it('iterator descends into all heading levels', () => {
    const md = [
      '# H1 with `code1`',
      '## H2 with `code2`',
      '### H3 with `code3`',
      '#### H4 with `code4`',
      '##### H5 with `code5`',
      '###### H6 with `code6`',
      '',
    ].join('\n');
    const state = makeState(md);
    const visited = visitedNodeNames(state);
    const inlineCodeCount = visited.filter((n) => n === 'InlineCode').length;
    expect(inlineCodeCount).toBe(6);
  });

  it('iterator descends so Emphasis/StrongEmphasis inside headings are reached', () => {
    const state = makeState('## Heading with *italic* and **bold**\n');
    const visited = visitedNodeNames(state);
    expect(visited).toContain('Emphasis');
    expect(visited).toContain('StrongEmphasis');
  });
});

interface Emitted {
  from: number;
  to: number;
  kind: 'line' | 'replace' | 'mark';
  cls?: string;
}

/**
 * Runs `decorateHeading` on every ATX heading of `doc` and returns what it
 * emitted, in emission order. A structural view is enough: the decorator and
 * `shouldReveal` read only `state`.
 */
function headingDecorations(doc: string, anchor: number, extra: Extension[] = []): Emitted[] {
  const state = makeState(doc, anchor, extra);
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  if (!tree) throw new Error('parse did not finish');
  const view = { state } as unknown as EditorView;
  const out: Emitted[] = [];
  const sink = {
    add(from: number, to: number, value: Decoration) {
      const spec = value.spec as { class?: string };
      // A line decoration is a point decoration too, so tell it apart first.
      const kind = /^cm-md-h[1-6]$/.test(spec.class ?? '') ? 'line' : value.point ? 'replace' : 'mark';
      out.push({ from, to, kind, cls: spec.class });
    },
  };
  tree.iterate({
    enter(node) {
      if (/^ATXHeading[1-6]$/.test(node.name)) decorateHeading(view, node.node, sink);
    },
  });
  return out;
}

const textMarks = (list: Emitted[]) => list.filter((d) => d.cls === 'cm-md-heading-text');

describe('heading text mark (.cm-md-heading-text)', () => {
  // Caret on the trailing paragraph, so live-preview does not reveal the heading.
  it('covers the text after "# " to the end of the heading', () => {
    const doc = '# Title\n\npara';
    const list = headingDecorations(doc, doc.length);
    expect(textMarks(list)).toEqual([{ from: 2, to: 7, kind: 'mark', cls: 'cm-md-heading-text' }]);
    // The marker run + space is still hidden by the replace, which ends where
    // the mark starts, and the line class is unchanged.
    expect(list.find((d) => d.kind === 'replace')).toMatchObject({ from: 0, to: 2 });
    expect(list.find((d) => d.kind === 'line')).toMatchObject({ from: 0, cls: 'cm-md-h1' });
  });

  it('starts after a longer marker run too', () => {
    const doc = '### Deep one\n\npara';
    expect(textMarks(headingDecorations(doc, doc.length))).toEqual([
      { from: 4, to: 12, kind: 'mark', cls: 'cm-md-heading-text' },
    ]);
  });

  it('emits no mark for an empty heading ("## ")', () => {
    const doc = '## \n\npara';
    const list = headingDecorations(doc, doc.length);
    expect(list.some((d) => d.kind === 'line')).toBe(true);
    expect(textMarks(list)).toEqual([]);
  });

  it('emits no mark for a bare marker ("#")', () => {
    const doc = '#\n\npara';
    expect(textMarks(headingDecorations(doc, doc.length))).toEqual([]);
  });

  it('spans inline formatting as one range, **bold** included', () => {
    const doc = '## A **bold** word\n\npara';
    expect(textMarks(headingDecorations(doc, doc.length))).toEqual([
      { from: 3, to: 18, kind: 'mark', cls: 'cm-md-heading-text' },
    ]);
  });

  it('is absent when live-preview reveals the heading (caret inside)', () => {
    const doc = '# Title\n\npara';
    expect(headingDecorations(doc, 4)).toEqual([]);
  });

  it('stays when live-render keeps the heading rendered under the caret', () => {
    const doc = '# Title\n\npara';
    const list = headingDecorations(doc, 4, [flavourFacet.of(LIVE_RENDER)]);
    expect(textMarks(list)).toEqual([{ from: 2, to: 7, kind: 'mark', cls: 'cm-md-heading-text' }]);
  });
});
