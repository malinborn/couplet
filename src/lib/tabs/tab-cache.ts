import type { StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { closeCompletion } from '@codemirror/autocomplete';
import { clearAiAsks } from '../editor/ai-ask';
import { clearAiComments } from '../editor/ai-comment';
import { clearJsonOffer } from '../editor/json-paste';
import { closeThemePicker, type ThemeControl } from '../editor/slash-theme';
import { closeTonePicker } from '../editor/slash-tone';

/**
 * What must not stay in a state that goes to the background:
 * - ask widgets: the controller's `ai.leave` parks their questions before the
 *   strip and `ai.enter` places them again on return, so a widget kept in
 *   the cached state would be a second copy of the same question;
 * - comment cards: rebuilt from the sidecar on return, and a cached card
 *   would carry a textarea with stale text;
 * - the JSON offer: its toast belongs to the window and is withdrawn on leave;
 * - an open `/theme` or `/tone` picker: its preview belongs to the window, and
 *   only the picker's own update listener would ever clear it — which a state
 *   in the background, or `setState`, never runs.
 *
 * AI highlights stay: they mark an agent's edit nobody has looked at yet.
 */
export function leaveEffects(): StateEffect<unknown>[] {
  return [
    clearAiAsks.of(null),
    clearAiComments.of(null),
    clearJsonOffer.of(null),
    closeThemePicker.of(null),
    closeTonePicker.of(null),
  ];
}

/**
 * Clean the live state before it leaves the view (a tab switch, a close).
 *
 * The pickers close first, in their own transaction: the completion popup
 * closing while a picker is still open reads to the picker as an abort, and
 * its abort deletes the typed filter from a microtask — by then on the view's
 * *next* state, another tab's text. Then the popup, whose options belong to
 * the leaving state, and last the theme preview, put back to the saved theme.
 */
export function stripLeavingState(view: EditorView, themeControl?: ThemeControl): void {
  view.dispatch({ effects: leaveEffects() });
  closeCompletion(view);
  themeControl?.previewFamily(null);
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
