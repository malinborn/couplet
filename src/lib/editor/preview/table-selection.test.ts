// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from '../markdown-language';
import { findContainingTable, tableSelectionSnapOut } from './table-selection';
import { DEFAULT_TABLE_CONFIG, tableConfig, type TableConfig } from './table-config';

function tableAtLine(
  doc: string,
  lineNumber: number,
  config?: TableConfig
): { from: number; to: number } | null {
  const state = EditorState.create({
    doc,
    extensions: [markdownExtension(), ...(config ? [tableConfig.of(config)] : [])],
  });
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

  // A table over the cap stays raw markdown (buildTableContext returns null),
  // so its rows are visible, editable lines — snapping the caret off them
  // made the raw table uneditable.
  it('ignores a table longer than tableConfig.maxLines, at exactly maxLines it owns the rows', () => {
    const table = (lines: number) =>
      ['| a | b |', '| - | - |', ...Array.from({ length: lines - 2 }, (_, i) => `| ${i} | x |`)].join('\n');
    const max = DEFAULT_TABLE_CONFIG.maxLines;
    expect(tableAtLine(table(max), 3)).not.toBeNull();
    expect(tableAtLine(table(max + 1), 3)).toBeNull();
    expect(tableAtLine(table(4), 3, { maxLines: 4, placeholder: '-' })).not.toBeNull();
    expect(tableAtLine(table(5), 3, { maxLines: 4, placeholder: '-' })).toBeNull();
  });
});

describe('the snap-out on a table over the cap', () => {
  it('leaves a caret on a raw data line where it is', async () => {
    const lines = ['| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |'];
    const doc = ['intro', '', ...lines, '', 'outro'].join('\n');
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [markdownExtension(), tableConfig.of({ maxLines: 4, placeholder: '-' }), tableSelectionSnapOut],
      }),
    });
    ensureSyntaxTree(view.state, doc.length, 5000);
    const dataLine = view.state.doc.line(4); // `| 1 | 2 |`
    view.dispatch({ selection: { anchor: dataLine.from + 2 } });
    await Promise.resolve(); // the snap-out dispatches from a microtask
    expect(view.state.selection.main.head).toBe(dataLine.from + 2);
    view.destroy();
    parent.remove();
  });
});
