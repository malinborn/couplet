import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { slashInProgress } from './slash-in-progress';
import { closeThemePicker, openThemePicker, themePickerField } from './slash-theme';
import { openTonePicker, tonePickerField } from './slash-tone';

function state(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [themePickerField, tonePickerField] });
}

describe('slashInProgress', () => {
  it('IsFalseForPlainText', () => {
    expect(slashInProgress(state('aut'))).toBe(false);
  });

  it('IsTrueWhileTheThemePickerTakesAFilter', () => {
    // `/theme` has removed its own text; what is typed now filters the list.
    const s = state('').update({ effects: openThemePicker.of({ anchor: 0 }) }).state;
    expect(slashInProgress(s.update({ changes: { from: 0, insert: 'aut' } }).state)).toBe(true);
  });

  it('IsTrueWhileTheTonePickerIsOpen', () => {
    expect(slashInProgress(state('').update({ effects: openTonePicker.of({ anchor: 0 }) }).state)).toBe(true);
  });

  it('IsFalseAgainOnceThePickerClosed', () => {
    const open = state('').update({ effects: openThemePicker.of({ anchor: 0 }) }).state;
    expect(slashInProgress(open.update({ effects: closeThemePicker.of(null) }).state)).toBe(false);
  });

  it('IsFalseForAStateWithoutThePickers', () => {
    expect(slashInProgress(EditorState.create({ doc: 'x' }))).toBe(false);
  });
});
