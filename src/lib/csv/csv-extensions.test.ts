// @vitest-environment jsdom
/**
 * `csvPreviewExtensions` installed in a real `EditorView`: a CSV far past the
 * markdown row cap still renders as the table widget, and the one-table guard
 * runs on transactions dispatched through the view.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { history, historyKeymap, undo } from '@codemirror/commands';
import { computeReplacement } from '../editor/content-diff';
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

/**
 * CM6 dispatches undo/redo with `filter: false`, so the one-table filter never
 * sees them; the CSV bundle guards every way into the history instead. Each
 * case: delete a row (whole-table replace), reload a different file silently
 * and single-span like `updateContent`, then undo — whose mapped inverse
 * would glue the deleted rows onto the new table.
 */
describe('undo across a disk reload, through the view', () => {
  const isMac = /Mac/.test(navigator.platform);

  function viewAfterReload(preview: Extension): { view: EditorView; disk: string } {
    const view = new EditorView({
      state: EditorState.create({
        doc: rowsToTable([['a', 'b'], ['1', '2'], ['3', '4']]),
        // The order setup.ts uses: history + its keymap at default precedence.
        extensions: [markdownExtension(), history(), keymap.of(historyKeymap), preview],
      }),
    });
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: rowsToTable([['a', 'b'], ['1', '2']]) },
      userEvent: 'input',
    });
    const disk = rowsToTable([['x', 'y', 'z'], ['9', '8', '7']]);
    const repl = computeReplacement(view.state.doc.toString(), disk);
    if (!repl) throw new Error('no replacement');
    view.dispatch({ changes: repl, annotations: Transaction.addToHistory.of(false) });
    expect(view.state.doc.toString()).toBe(disk);
    return { view, disk };
  }

  function pressUndo(view: EditorView): void {
    const event = new KeyboardEvent('keydown', { key: 'z', metaKey: isMac, ctrlKey: !isMac });
    runScopeHandlers(view, event, 'editor');
  }

  function menuUndo(view: EditorView): void {
    view.contentDOM.dispatchEvent(
      new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true })
    );
  }

  it('Mod-z leaves the reloaded table alone', () => {
    const { view, disk } = viewAfterReload(csvPreviewExtensions);
    pressUndo(view);
    expect(view.state.doc.toString()).toBe(disk);
    view.destroy();
  });

  it('a historyUndo input event (the native Edit menu) leaves it alone too', () => {
    const { view, disk } = viewAfterReload(csvPreviewExtensions);
    menuUndo(view);
    expect(view.state.doc.toString()).toBe(disk);
    view.destroy();
  });

  it('control: without the CSV bundle both paths glue the old rows on', () => {
    for (const run of [pressUndo, menuUndo]) {
      const { view } = viewAfterReload(livePreviewPlugin);
      run(view);
      expect(view.state.doc.toString()).toContain('| 3 | 4 |\nx | y | z |');
      view.destroy();
    }
  });

  /**
   * A redo pending across a reload: delete a row, undo it, reload. Mod-y is
   * the redo key on every platform but macOS — this file runs on jsdom's
   * default (empty) platform; the mac keys are in `csv-history-mac.test.ts`.
   */
  function redoAcrossReload(preview: Extension): { view: EditorView; disk: string } {
    const doc = rowsToTable([['a', 'b'], ['1', '2'], ['3', '4']]);
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [markdownExtension(), history(), keymap.of(historyKeymap), preview],
      }),
    });
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: rowsToTable([['a', 'b'], ['1', '2']]) },
      userEvent: 'input',
    });
    undo(view);
    expect(view.state.doc.toString()).toBe(doc);
    const disk = rowsToTable([['x', 'y', 'z'], ['9', '8', '7']]);
    const repl = computeReplacement(view.state.doc.toString(), disk);
    if (!repl) throw new Error('no replacement');
    view.dispatch({ changes: repl, annotations: Transaction.addToHistory.of(false) });
    expect(view.state.doc.toString()).toBe(disk);
    return { view, disk };
  }

  const pressModY = (view: EditorView) =>
    runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'y', metaKey: isMac, ctrlKey: !isMac }), 'editor');

  it('Mod-y (redo) leaves the reloaded table alone', () => {
    const { view, disk } = redoAcrossReload(csvPreviewExtensions);
    expect(pressModY(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(disk);
    view.destroy();
  });

  it('control: without the CSV bundle Mod-y glues the kept rows on', () => {
    const { view } = redoAcrossReload(livePreviewPlugin);
    expect(pressModY(view)).toBe(true);
    expect(view.state.doc.toString()).toContain('| 1 | 2 |\nx | y | z |');
    view.destroy();
  });

  it('Mod-z still undoes an ordinary cell edit', () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: rowsToTable([['a', 'b'], ['1', '2']]),
        extensions: [markdownExtension(), history(), keymap.of(historyKeymap), csvPreviewExtensions],
      }),
    });
    const before = view.state.doc.toString();
    const at = before.indexOf('1');
    view.dispatch({ changes: { from: at, to: at + 1, insert: 'one' }, userEvent: 'input' });
    pressUndo(view);
    expect(view.state.doc.toString()).toBe(before);
    view.destroy();
  });
});
