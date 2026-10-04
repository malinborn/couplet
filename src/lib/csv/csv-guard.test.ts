// src/lib/csv/csv-guard.test.ts
import { describe, it, expect } from 'vitest';
import { EditorState, Transaction } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import { computeReplacement } from '../editor/content-diff';
import { csvEditGuard, csvRedo, csvUndo } from './csv-guard';
import { rowsToTable } from './csv-table';

const DOC = rowsToTable([['a', 'b'], ['1', '2']]); // '| a | b |\n| - | - |\n| 1 | 2 |\n'

function stateOf(doc = DOC) {
  return EditorState.create({ doc, extensions: [csvEditGuard, history()] });
}

describe('csvEditGuard', () => {
  it('drops typing after the table', () => {
    const s = stateOf();
    const next = s.update({ changes: { from: s.doc.length, insert: 'hello' } }).state;
    expect(next.doc.toString()).toBe(DOC);
  });

  it('drops text inserted before the table', () => {
    const s = stateOf();
    expect(s.update({ changes: { from: 0, insert: '# t\n' } }).state.doc.toString()).toBe(DOC);
  });

  it('lets a cell edit through', () => {
    const s = stateOf();
    const at = DOC.indexOf('1');
    const next = s.update({ changes: { from: at, to: at + 1, insert: 'one' } }).state;
    expect(next.doc.toString()).toContain('| one |');
  });

  it('lets a new row through', () => {
    const s = stateOf();
    const end = DOC.length - 1; // before the trailing newline
    const next = s.update({ changes: { from: end, insert: '\n| x | y |' } }).state;
    expect(next.doc.lines).toBe(5);
  });

  it('lets a row whose cells were all emptied through', () => {
    const s = stateOf();
    const row = s.doc.line(3);
    const next = s.update({ changes: { from: row.from, to: row.to, insert: '|   |   |' } }).state;
    expect(next.doc.line(3).text).toBe('|   |   |');
  });

  it('lets a reload from disk through, even when it is not a table', () => {
    const s = stateOf();
    const next = s.update({
      changes: { from: 0, to: s.doc.length, insert: 'a,"broken\n' },
      annotations: Transaction.addToHistory.of(false),
    }).state;
    expect(next.doc.toString()).toBe('a,"broken\n');
  });

  it('lets undo through', () => {
    let s = stateOf();
    const at = DOC.indexOf('1');
    s = s.update({ changes: { from: at, to: at + 1, insert: 'one' }, userEvent: 'input' }).state;
    let undone = s;
    undo({ state: s, dispatch: (tr) => { undone = tr.state; } });
    expect(undone.doc.toString()).toBe(DOC);
  });

  it('lets redo of an accepted edit through', () => {
    let s = stateOf();
    const at = DOC.indexOf('1');
    s = s.update({ changes: { from: at, to: at + 1, insert: 'one' }, userEvent: 'input' }).state;
    const edited = s.doc.toString();
    undo({ state: s, dispatch: (tr) => { s = tr.state; } });
    expect(s.doc.toString()).toBe(DOC);
    redo({ state: s, dispatch: (tr) => { s = tr.state; } });
    expect(s.doc.toString()).toBe(edited);
  });

  it('lets the guarded undo and redo of an accepted edit through', () => {
    let s = stateOf();
    const at = DOC.indexOf('1');
    s = s.update({ changes: { from: at, to: at + 1, insert: 'one' }, userEvent: 'input' }).state;
    const edited = s.doc.toString();
    expect(csvUndo({ state: s, dispatch: (tr) => { s = tr.state; } })).toBe(true);
    expect(s.doc.toString()).toBe(DOC);
    expect(csvRedo({ state: s, dispatch: (tr) => { s = tr.state; } })).toBe(true);
    expect(s.doc.toString()).toBe(edited);
  });

  it('leaves an empty history to the plain commands', () => {
    const s = stateOf();
    let dispatched = false;
    expect(csvUndo({ state: s, dispatch: () => { dispatched = true; } })).toBe(false);
    expect(dispatched).toBe(false);
  });

  it('drops an undo that crosses a disk reload and would not leave a table', () => {
    let { state: s, disk } = editThenReload();
    // Consumed, so the plain `undo` behind it in the keymap cannot run.
    expect(csvUndo({ state: s, dispatch: (tr) => { s = tr.state; } })).toBe(true);
    expect(s.doc.toString()).toBe(disk);
  });

  it('why the filter alone cannot: a plain undo carries filter:false and skips it', () => {
    let { state: s } = editThenReload();
    undo({ state: s, dispatch: (tr) => { s = tr.state; } });
    expect(s.doc.toString()).toContain('| 3 | 4 |\nx | y | z |');
  });
});

/**
 * Delete a row the way a table operation does (whole-table replace), then
 * reload a different file silently, single-span, like `Editor.svelte`'s
 * `updateContent`. The undo history is mapped through that reload, so the
 * inverse of the deletion lands at the edge of the replaced span — glued onto
 * the new table; autosave would then write markdown into the .csv.
 */
function editThenReload(): { state: EditorState; disk: string } {
  let s = stateOf(rowsToTable([['a', 'b'], ['1', '2'], ['3', '4']]));
  s = s.update({
    changes: { from: 0, to: s.doc.length, insert: rowsToTable([['a', 'b'], ['1', '2']]) },
    userEvent: 'input',
  }).state;
  const disk = rowsToTable([['x', 'y', 'z'], ['9', '8', '7']]);
  const repl = computeReplacement(s.doc.toString(), disk);
  if (!repl) throw new Error('no replacement');
  s = s.update({ changes: repl, annotations: Transaction.addToHistory.of(false) }).state;
  if (s.doc.toString() !== disk) throw new Error('reload did not land');
  return { state: s, disk };
}
