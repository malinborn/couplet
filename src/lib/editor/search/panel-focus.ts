import { StateEffect, StateField } from '@codemirror/state';
import { searchPanelOpen } from '@codemirror/search';

/**
 * Whether the keyboard is in the Find panel's query or replace field.
 *
 * This is what turns the spotlight on: the document dims only while the human
 * is *searching*, and a click back into the text — to edit what was found —
 * takes the dimming away while the matches stay highlighted. Focus is DOM
 * state, so the panel reports it with an effect; keeping it in the editor
 * state lets the spotlight's layer and decorations react to it like to any
 * other change. A closed panel is never focused, whatever was reported last.
 */
export const setSearchFocus = StateEffect.define<boolean>();

export const searchFocusField = StateField.define<boolean>({
  create() {
    return false;
  },
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setSearchFocus)) value = effect.value;
    return value && searchPanelOpen(tr.state);
  },
});
