// src/lib/csv/csv-guard.test.ts
import { describe, it, expect } from 'vitest';
import { EditorState, Transaction } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { csvEditGuard } from './csv-guard';
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
});
