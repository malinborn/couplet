// @vitest-environment jsdom
/**
 * The CSV history guard under macOS key resolution — the platform couplet
 * ships on. CM6 picks the platform's bindings once, when `@codemirror/view`
 * is first evaluated, so `navigator.platform` is set in `vi.hoisted`, ahead of
 * the imports (vitest isolates each test file's module graph). Mod-Shift-z and
 * Mod-Shift-u are mac-only bindings; jsdom's default platform is '' and never
 * reaches them, which is why these cases live in their own file. Every guarded
 * case has a control proving the key really is a history key here.
 */
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
});

import { EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { history, historyKeymap, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { computeReplacement } from '../editor/content-diff';
import { markdownExtension } from '../editor/markdown-language';
import { livePreviewPlugin } from '../editor/preview/plugin';
import { csvPreviewExtensions } from './csv-extensions';
import { rowsToTable } from './csv-table';

const THREE_ROWS = rowsToTable([['a', 'b'], ['1', '2'], ['3', '4']]);
const TWO_ROWS = rowsToTable([['a', 'b'], ['1', '2']]);
const DISK = rowsToTable([['x', 'y', 'z'], ['9', '8', '7']]);
/**
 * What a mapped history step leaves when it glues old rows onto the reloaded
 * table: a row's closing pipe and the new header's first cell share a line
 * break, the new header having lost its leading `|`.
 */
const GLUED = '|\nx | y | z |';

function makeView(preview: Extension): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc: THREE_ROWS,
      // The order setup.ts uses: history + its keymap at default precedence.
      extensions: [markdownExtension(), history(), keymap.of(historyKeymap), preview],
    }),
  });
}

/** Delete a row the way a table operation does: a whole-table replace. */
function deleteRow(view: EditorView): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: TWO_ROWS }, userEvent: 'input' });
}

/** A different file, silently and single-span, like `Editor.svelte`'s `updateContent`. */
function reload(view: EditorView): void {
  const repl = computeReplacement(view.state.doc.toString(), DISK);
  if (!repl) throw new Error('no replacement');
  view.dispatch({ changes: repl, annotations: Transaction.addToHistory.of(false) });
  expect(view.state.doc.toString()).toBe(DISK);
}

/** An undo is pending whose mapped inverse would glue the deleted row back on. */
function undoAcrossReload(preview: Extension): EditorView {
  const view = makeView(preview);
  deleteRow(view);
  reload(view);
  return view;
}

/** A redo is pending whose mapped change would glue the kept rows on. */
function redoAcrossReload(preview: Extension): EditorView {
  const view = makeView(preview);
  deleteRow(view);
  undo(view);
  expect(view.state.doc.toString()).toBe(THREE_ROWS);
  reload(view);
  return view;
}

function press(view: EditorView, init: KeyboardEventInit): boolean {
  return runScopeHandlers(view, new KeyboardEvent('keydown', init), 'editor');
}

const CMD_Z = { key: 'z', metaKey: true };
const CMD_SHIFT_Z = { key: 'z', metaKey: true, shiftKey: true };
const CMD_U = { key: 'u', metaKey: true };
const CMD_SHIFT_U = { key: 'u', metaKey: true, shiftKey: true };

describe('CSV history guard, macOS keys', () => {
  it('Cmd+Shift+Z (redo) leaves the reloaded table alone', () => {
    const view = redoAcrossReload(csvPreviewExtensions);
    expect(press(view, CMD_SHIFT_Z)).toBe(true);
    expect(view.state.doc.toString()).toBe(DISK);
    view.destroy();
  });

  it('Cmd+U (undoSelection) is guarded too', () => {
    const view = undoAcrossReload(csvPreviewExtensions);
    expect(press(view, CMD_U)).toBe(true);
    expect(view.state.doc.toString()).toBe(DISK);
    view.destroy();
  });

  it('Cmd+Shift+U (redoSelection) is guarded too', () => {
    const view = redoAcrossReload(csvPreviewExtensions);
    expect(press(view, CMD_SHIFT_U)).toBe(true);
    expect(view.state.doc.toString()).toBe(DISK);
    view.destroy();
  });

  it('control: without the CSV bundle each of those keys glues the old rows on', () => {
    const cases: [(preview: Extension) => EditorView, KeyboardEventInit][] = [
      [redoAcrossReload, CMD_SHIFT_Z],
      [undoAcrossReload, CMD_U],
      [redoAcrossReload, CMD_SHIFT_U],
      [undoAcrossReload, CMD_Z],
    ];
    for (const [setup, key] of cases) {
      const view = setup(livePreviewPlugin);
      expect(press(view, key)).toBe(true);
      expect(view.state.doc.toString()).toContain(GLUED);
      view.destroy();
    }
  });

  it('a second Cmd+Z after a refused one is refused again, and the history is untouched', () => {
    const view = undoAcrossReload(csvPreviewExtensions);
    const depths = () => [undoDepth(view.state), redoDepth(view.state)];
    const before = depths();
    expect(before).toEqual([1, 0]);

    expect(press(view, CMD_Z)).toBe(true);
    expect(view.state.doc.toString()).toBe(DISK);
    expect(depths()).toEqual(before);

    expect(press(view, CMD_Z)).toBe(true);
    expect(view.state.doc.toString()).toBe(DISK);
    expect(depths()).toEqual(before);

    // Nothing was undone, so there is nothing to redo.
    press(view, CMD_SHIFT_Z);
    expect(view.state.doc.toString()).toBe(DISK);
    expect(depths()).toEqual(before);
    view.destroy();
  });
});
