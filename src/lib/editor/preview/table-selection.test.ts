import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from '../markdown-language';
import { findContainingTable } from './table-selection';

function tableAtLine(doc: string, lineNumber: number): { from: number; to: number } | null {
  const state = EditorState.create({ doc, extensions: [markdownExtension()] });
  ensureSyntaxTree(state, doc.length, 5000);
  return findContainingTable(state, state.doc.line(lineNumber));
}

describe('findContainingTable — which lines the snap-out owns', () => {
  it('finds a rendered table from one of its hidden body rows', () => {
    expect(tableAtLine('| a | b |\n| - | - |\n| 1 | 2 |', 3)).not.toBeNull();
  });

  // A table inside a quote stays raw text (plugin.ts), so its rows are real,
  // visible lines — snapping the caret off them made the body uneditable.
  it('ignores a table inside a blockquote', () => {
    expect(tableAtLine('> | a | b |\n> | - | - |\n> | 1 | 2 |', 3)).toBeNull();
    expect(tableAtLine('> > | a | b |\n> > | - | - |\n> > | 1 | 2 |', 2)).toBeNull();
  });
});
