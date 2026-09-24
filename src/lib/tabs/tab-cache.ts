import type { StateEffect } from '@codemirror/state';
import { clearAiAsks } from '../editor/ai-ask';
import { clearAiComments } from '../editor/ai-comment';
import { clearJsonOffer } from '../editor/json-paste';

/**
 * What must not stay in a state that goes to the background:
 * - ask widgets: the controller's `ai.leave` parks their questions before the
 *   strip and `ai.enter` places them again on return, so a widget kept in
 *   the cached state would be a second copy of the same question;
 * - comment cards: rebuilt from the sidecar on return, and a cached card
 *   would carry a textarea with stale text;
 * - the JSON offer: its toast belongs to the window and is withdrawn on leave.
 *
 * AI highlights stay: they mark an agent's edit nobody has looked at yet.
 */
export function leaveEffects(): StateEffect<unknown>[] {
  return [clearAiAsks.of(null), clearAiComments.of(null), clearJsonOffer.of(null)];
}

export type EnterDecision = 'use-cache' | 'load-fresh';

/**
 * A cached file tab is reused only while the disk holds exactly what it held
 * when the tab was left; anything else reloads from disk (the undo history of
 * that tab is the price). `null` means the file does not exist.
 *
 * Content, not mtime: reading a markdown file is what hashing it would cost
 * anyway, and an exact compare cannot be fooled by an mtime-preserving write.
 */
export function decideEnter(input: { baseline: string | null; disk: string | null }): EnterDecision {
  return input.baseline === input.disk ? 'use-cache' : 'load-fresh';
}
