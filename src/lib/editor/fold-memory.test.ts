import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { codeFolding, foldEffect, foldedRanges, foldable } from '@codemirror/language';
import { Strikethrough, Table } from '@lezer/markdown';
import { markdownFoldService } from './folding.js';
import {
  foldMemory,
  foldSuspendEffects,
  foldRestoreEffects,
  stashedFolds,
} from './fold-memory.js';

function stateFor(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, extensions: [Strikethrough, Table] }),
      markdownFoldService,
      codeFolding(),
      foldMemory,
    ],
  });
}

/** Folds the heading on `lineNumber`, the way the click handler does. */
function fold(state: EditorState, lineNumber: number): EditorState {
  const line = state.doc.line(lineNumber);
  const range = foldable(state, line.from, line.to);
  if (!range) throw new Error(`line ${lineNumber} is not foldable: ${line.text}`);
  return state.update({ effects: foldEffect.of(range) }).state;
}

function foldedLineNumbers(state: EditorState): number[] {
  const out: number[] = [];
  foldedRanges(state).between(0, state.doc.length, (from) => {
    out.push(state.doc.lineAt(from).number);
  });
  return out;
}

const DOC = [
  '# Alpha section', // 1
  'alpha body one', // 2
  'alpha body two', // 3
  '', // 4
  '## Beta subsection', // 5
  'beta body', // 6
  '', // 7
  '# Gamma section', // 8
  'gamma body one', // 9
  'gamma body two', // 10
].join('\n');

describe('fold memory across the Raw switch', () => {
  it('unfolds everything on the way into Raw', () => {
    let state = stateFor(DOC);
    state = fold(state, 1);
    state = fold(state, 8);
    expect(foldedLineNumbers(state)).toEqual([1, 8]);

    state = state.update({ effects: foldSuspendEffects(state) }).state;
    expect(foldedLineNumbers(state)).toEqual([]);
    expect(stashedFolds(state)).toHaveLength(2);
  });

  it('produces no effects when nothing is folded, so it cannot clobber a stash', () => {
    let state = stateFor(DOC);
    state = fold(state, 1);
    state = state.update({ effects: foldSuspendEffects(state) }).state;
    const stash = stashedFolds(state);

    // A second entry into Raw — applyPreviewConfig re-runs on its own.
    expect(foldSuspendEffects(state)).toEqual([]);
    expect(stashedFolds(state)).toEqual(stash);
  });

  it('restores the same headings on the way out', () => {
    let state = stateFor(DOC);
    state = fold(state, 1);
    state = fold(state, 8);
    state = state.update({ effects: foldSuspendEffects(state) }).state;

    state = state.update({ effects: foldRestoreEffects(state) }).state;
    expect(foldedLineNumbers(state)).toEqual([1, 8]);
    expect(stashedFolds(state)).toEqual([]);
  });

  it('maps stashed positions through an edit made while in Raw', () => {
    let state = stateFor(DOC);
    state = fold(state, 8);
    state = state.update({ effects: foldSuspendEffects(state) }).state;

    // A whole new section arrives above everything else.
    state = state.update({ changes: { from: 0, insert: '# Zero\nzero body\n\n' } }).state;
    state = state.update({ effects: foldRestoreEffects(state) }).state;

    // Gamma is now line 11; the stash followed it rather than folding line 8.
    expect(state.doc.line(11).text).toBe('# Gamma section');
    expect(foldedLineNumbers(state)).toEqual([11]);
  });

  it('re-derives the extent, so a section grown in Raw folds completely', () => {
    let state = stateFor(DOC);
    state = fold(state, 8);
    state = state.update({ effects: foldSuspendEffects(state) }).state;

    state = state.update({ changes: { from: state.doc.length, insert: '\ngamma body three' } }).state;
    state = state.update({ effects: foldRestoreEffects(state) }).state;

    let foldedTo = -1;
    foldedRanges(state).between(0, state.doc.length, (_from, to) => {
      foldedTo = to;
    });
    expect(foldedTo).toBe(state.doc.length);
  });

  it('drops a fold whose heading was deleted in Raw instead of folding a paragraph', () => {
    let state = stateFor(DOC);
    state = fold(state, 1);
    state = fold(state, 8);
    state = state.update({ effects: foldSuspendEffects(state) }).state;

    const heading = state.doc.line(1);
    state = state.update({ changes: { from: heading.from, to: heading.to + 1, insert: '' } }).state;
    state = state.update({ effects: foldRestoreEffects(state) }).state;

    // Only Gamma — now line 7 — comes back.
    expect(state.doc.line(7).text).toBe('# Gamma section');
    expect(foldedLineNumbers(state)).toEqual([7]);
  });

  it('does not refold after the user unfolds and visits Raw again', () => {
    let state = stateFor(DOC);
    state = fold(state, 1);
    state = state.update({ effects: foldSuspendEffects(state) }).state;
    state = state.update({ effects: foldRestoreEffects(state) }).state;

    // User unfolds by hand, then goes to Raw and back with nothing folded.
    const range = foldable(state, state.doc.line(1).from, state.doc.line(1).to);
    state = state.update({ effects: foldEffect.of(range!) }).state;
    state = state.update({ effects: [] }).state;

    // Nothing stashed, so the round trip is a no-op either way.
    expect(stashedFolds(state)).toEqual([]);
    expect(foldRestoreEffects(state)).toEqual([]);
  });
});
