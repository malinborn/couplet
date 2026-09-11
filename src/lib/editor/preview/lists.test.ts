import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { Strikethrough, Table } from '@lezer/markdown';
import { listItemDepth } from './lists.js';

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, extensions: [Strikethrough, Table] }),
    ],
  });
}

/** `[line number, depth]` for every ListItem in the document. */
function depthsByLine(doc: string): [number, number][] {
  const state = makeState(doc);
  const out: [number, number][] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'ListItem') return;
      out.push([state.doc.lineAt(node.from).number, listItemDepth(node.node)]);
    },
  });
  return out.sort((a, b) => a[0] - b[0]);
}

describe('listItemDepth', () => {
  it('counts bullet nesting from one', () => {
    const doc = [
      '- top',
      '  - second',
      '    - third',
      '      - fourth',
      '- back to top',
    ].join('\n');
    expect(depthsByLine(doc)).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 1],
    ]);
  });

  it('counts ordered nesting the same way', () => {
    const doc = ['1. one', '2. two', '   1. inner a', '   2. inner b'].join('\n');
    expect(depthsByLine(doc)).toEqual([
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
    ]);
  });

  it('steps by one per level regardless of how wide the source indent is', () => {
    // Four-space indents must not read as two levels — the depth comes from
    // the tree, not from counting spaces.
    const wide = ['- top', '    - second', '        - third'].join('\n');
    expect(depthsByLine(wide).map(([, d]) => d)).toEqual([1, 2, 3]);
  });

  it('counts a list nested inside a blockquote from one', () => {
    const doc = ['> - quoted top', '>   - quoted second'].join('\n');
    expect(depthsByLine(doc).map(([, d]) => d)).toEqual([1, 2]);
  });
});
