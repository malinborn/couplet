import { Transaction } from '@codemirror/state';
import { setAiHighlights } from './ai-highlight';

/** The part of a `ViewUpdate` the question needs — a plain object in tests. */
export interface EditUpdate {
  readonly docChanged: boolean;
  readonly transactions: readonly Transaction[];
}

/**
 * Did the human change the document in this update — a key, ⌘V, ⌘X, ⌘B, a
 * checkbox, a drop, undo, redo? Two kinds of change are not theirs: an
 * agent's text, which always carries `setAiHighlights` (`aiEditTransaction`,
 * the comment-answer insert), and a reload from disk (`updateContent`: the
 * watcher, an external change), which stays out of the history. Undoing an
 * agent's edit is the human's act: the history replays no effects.
 */
export function isHumanEdit(update: EditUpdate): boolean {
  if (!update.docChanged) return false;
  return update.transactions.every(
    (tr) =>
      tr.annotation(Transaction.addToHistory) !== false &&
      !tr.effects.some((effect) => effect.is(setAiHighlights))
  );
}
