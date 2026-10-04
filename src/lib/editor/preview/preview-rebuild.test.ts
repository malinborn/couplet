// @vitest-environment jsdom
/**
 * `previewRebuild`: which view changes rebuild the live-preview decorations.
 * Markdown keeps rebuilding on selection and viewport (reveal-on-cursor
 * depends on them); a CSV tab turns both off, and what still has to work
 * there — the parked caret, the snap-out off hidden rows, edits, comments —
 * does not ride on that rebuild.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from '../markdown-language';
import { livePreviewPlugin, previewRebuild } from './plugin';
import { tableSelectionSnapOut } from './table-selection';
import { csvPreviewExtensions } from '../../csv/csv-extensions';
import { rowsToTable } from '../../csv/csv-table';
import { aiCommentField } from '../ai-comment';

const TABLE = rowsToTable([['a', 'b'], ['1', '2'], ['3', '4']]);

function viewWith(doc: string, preview: Extension): EditorView {
  const state = EditorState.create({ doc, extensions: [markdownExtension(), aiCommentField, preview, tableSelectionSnapOut] });
  ensureSyntaxTree(state, doc.length, 5000);
  const view = new EditorView({ state });
  view.dispatch({}); // spend the tree-completion rebuild
  return view;
}

const decorationsOf = (view: EditorView) => view.plugin(livePreviewPlugin)!.decorations;

describe('previewRebuild', () => {
  it('markdown (default): a selection-only update rebuilds', () => {
    const view = viewWith('# Title\n\n**bold** text\n', livePreviewPlugin);
    const before = decorationsOf(view);
    view.dispatch({ selection: { anchor: 12 } });
    expect(decorationsOf(view)).not.toBe(before);
    view.destroy();
  });

  it('opted out: a selection-only update keeps the decorations', () => {
    const view = viewWith(TABLE, [livePreviewPlugin, previewRebuild.of({ onSelection: false })]);
    const before = decorationsOf(view);
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 2 }, userEvent: 'select.cell' });
    expect(decorationsOf(view)).toBe(before);
    view.destroy();
  });

  it('opted out: a document change still rebuilds', () => {
    const view = viewWith(TABLE, [livePreviewPlugin, previewRebuild.of({ onSelection: false, onViewport: false })]);
    const before = decorationsOf(view);
    const at = view.state.doc.line(3).from + 2;
    view.dispatch({ changes: { from: at, to: at + 1, insert: 'one' } });
    expect(decorationsOf(view)).not.toBe(before);
    expect(view.dom.querySelector('.cm-md-table')!.textContent).toContain('one');
    view.destroy();
  });

  it('providers combine with OR: one asking for the rebuild gets it', () => {
    const view = viewWith(TABLE, [
      livePreviewPlugin,
      previewRebuild.of({ onSelection: false }),
      previewRebuild.of({ onSelection: true }),
    ]);
    const before = decorationsOf(view);
    view.dispatch({ selection: { anchor: 3 } });
    expect(decorationsOf(view)).not.toBe(before);
    view.destroy();
  });
});

describe('a CSV tab without selection-driven rebuilds', () => {
  it('a parked caret (select.cell) lands in the body row and keeps the widget DOM', () => {
    const view = viewWith(TABLE, csvPreviewExtensions);
    const wrap = view.dom.querySelector('.cm-md-table-wrap');
    const before = decorationsOf(view);
    const pos = view.state.doc.line(4).from + 2;
    view.dispatch({ selection: { anchor: pos }, userEvent: 'select.cell' });
    expect(view.state.selection.main.head).toBe(pos);
    expect(decorationsOf(view)).toBe(before);
    expect(view.dom.querySelector('.cm-md-table-wrap')).toBe(wrap);
    view.destroy();
  });

  it('an untagged caret on a hidden row is still snapped out', async () => {
    const view = viewWith(TABLE, csvPreviewExtensions);
    view.dispatch({ selection: { anchor: view.state.doc.line(4).from + 2 } });
    await Promise.resolve();
    await Promise.resolve();
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    expect(line).toBe(5); // moved down: the line after the table
    view.destroy();
  });
});
