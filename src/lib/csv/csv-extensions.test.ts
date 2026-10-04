// @vitest-environment jsdom
/**
 * `csvPreviewExtensions` installed in a real `EditorView`: a CSV far past the
 * markdown row cap still renders as the table widget, and the one-table guard
 * runs on transactions dispatched through the view.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from '../editor/markdown-language';
import { livePreviewPlugin } from '../editor/preview/plugin';
import { csvPreviewExtensions } from './csv-extensions';
import { rowsToTable } from './csv-table';

/** A canonical CSV buffer of `rows` rows: a header plus `rows - 1` data rows. */
function csvTable(rows: number): string {
  const out: string[][] = [['a', 'b']];
  for (let i = 0; i < rows - 1; i++) out.push([String(i), 'x']);
  return rowsToTable(out);
}

describe('csvPreviewExtensions through the view', () => {
  it('renders a 600-row CSV as a widget and drops text typed after it', () => {
    const doc = csvTable(600);
    const state = EditorState.create({ doc, extensions: [markdownExtension(), csvPreviewExtensions] });
    // Finish the parse up front: a partial Table node would be shorter than the
    // default 500-line cap and render for the wrong reason.
    expect(ensureSyntaxTree(state, doc.length, 5000)).not.toBeNull();
    const view = new EditorView({ state });
    // Spend the tree-completion rebuild on an empty transaction, so nothing
    // below passes merely because the finished tree arrived.
    view.dispatch({});

    expect(view.dom.querySelector('.cm-md-table')).not.toBeNull();

    view.dispatch({ changes: { from: view.state.doc.length, insert: 'hello' }, userEvent: 'input.type' });

    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  it('control: the bare markdown preview leaves the same table raw and lets the text in', () => {
    const doc = csvTable(600);
    const state = EditorState.create({ doc, extensions: [markdownExtension(), livePreviewPlugin] });
    expect(ensureSyntaxTree(state, doc.length, 5000)).not.toBeNull();
    const view = new EditorView({ state });
    view.dispatch({});

    expect(view.dom.querySelector('.cm-md-table')).toBeNull();

    view.dispatch({ changes: { from: view.state.doc.length, insert: 'hello' }, userEvent: 'input.type' });

    expect(view.state.doc.toString()).toBe(doc + 'hello');
    view.destroy();
  });
});
