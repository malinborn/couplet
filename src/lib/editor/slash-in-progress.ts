import type { EditorState } from '@codemirror/state';
import { completionStatus } from '@codemirror/autocomplete';
import { themePickerField } from './slash-theme';
import { tonePickerField } from './slash-tone';

/**
 * A slash command is still being chosen: the completion popup is showing, or
 * a `/theme` / `/tone` picker is open. What is typed meanwhile is a filter the
 * command's apply removes, not the document's text — an untitled tab waits
 * for it to finish before it becomes a note (stash plan 03). The picker
 * fields count on their own because the popup's status can read `pending`
 * while the list requeries after a keystroke. `pending` alone does not count: every
 * keystroke passes through it, so it would hold back every birth.
 */
export function slashInProgress(state: EditorState): boolean {
  return (
    completionStatus(state) === 'active' ||
    state.field(themePickerField, false) != null ||
    state.field(tonePickerField, false) != null
  );
}
