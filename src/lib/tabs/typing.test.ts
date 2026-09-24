// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  countsAsTyping,
  createTypingTracker,
  isEditableTarget,
  isHumanTyping,
  TYPING_GRACE_MS,
  TYPING_NOTE_INTERVAL_MS,
} from './typing';

function key(target: EventTarget | null, key = 'a', mods: { metaKey?: boolean; ctrlKey?: boolean } = {}) {
  return { key, target, metaKey: mods.metaKey ?? false, ctrlKey: mods.ctrlKey ?? false };
}

describe('isEditableTarget', () => {
  it('KnowsInputsTextareasAndContentEditable', () => {
    const editor = document.createElement('div');
    // The attribute, as CM6 sets it: jsdom does not implement the `contentEditable` property.
    editor.setAttribute('contenteditable', 'true');
    const inside = document.createElement('span');
    editor.appendChild(inside);
    document.body.appendChild(editor);
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(inside)).toBe(true);
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    editor.remove();
  });

  it('AnIslandMarkedFalseCountsOnlyOutsideAnEditor', () => {
    // A lone contenteditable="false" is not editable. Inside an editor (CM6
    // widgets are such islands) the rule reaches the editor above it: a key
    // there still counts as typing into the document.
    const lone = document.createElement('div');
    lone.setAttribute('contenteditable', 'false');
    const inLone = document.createElement('span');
    lone.appendChild(inLone);
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const widget = document.createElement('div');
    widget.setAttribute('contenteditable', 'false');
    const inWidget = document.createElement('span');
    widget.appendChild(inWidget);
    editor.appendChild(widget);
    document.body.append(lone, editor);
    expect(isEditableTarget(lone)).toBe(false);
    expect(isEditableTarget(inLone)).toBe(false);
    expect(isEditableTarget(inWidget)).toBe(true);
    lone.remove();
    editor.remove();
  });

  it('EveryInputCounts_ACheckboxToo', () => {
    // The rule is the element type, not whether it takes text.
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    expect(isEditableTarget(checkbox)).toBe(true);
  });
});

describe('countsAsTyping', () => {
  const input = document.createElement('input');
  it('CountsAPlainKeyIntoAnEditableElement', () => {
    expect(countsAsTyping(key(input))).toBe(true);
    expect(countsAsTyping(key(input, 'Backspace'))).toBe(true);
  });
  it('IgnoresShortcutsLoneModifiersAndKeysElsewhere', () => {
    expect(countsAsTyping(key(input, 's', { metaKey: true }))).toBe(false);
    expect(countsAsTyping(key(input, 'Tab', { ctrlKey: true }))).toBe(false);
    expect(countsAsTyping(key(input, 'Shift'))).toBe(false);
    expect(countsAsTyping(key(document.body))).toBe(false);
  });
});

describe('isHumanTyping', () => {
  it('IsTrueOnlyInAFocusedWindowWithinTheGrace', () => {
    expect(isHumanTyping({ focused: true, lastTypedAt: 1_000, now: 1_000 + TYPING_GRACE_MS - 1 })).toBe(true);
    expect(isHumanTyping({ focused: true, lastTypedAt: 1_000, now: 1_000 + TYPING_GRACE_MS })).toBe(false);
    expect(isHumanTyping({ focused: false, lastTypedAt: 1_000, now: 1_001 })).toBe(false);
    expect(isHumanTyping({ focused: true, lastTypedAt: 0, now: 5 })).toBe(false);
  });
});

describe('createTypingTracker', () => {
  it('RemembersTheLastTypedKey', () => {
    const clock = { now: 10_000, focused: true };
    const tracker = createTypingTracker({ now: () => clock.now, focused: () => clock.focused });
    expect(tracker.typing()).toBe(false);
    tracker.note(key(document.createElement('textarea')));
    expect(tracker.typing()).toBe(true);
    clock.now += TYPING_GRACE_MS;
    expect(tracker.typing()).toBe(false);
    tracker.note(key(document.body));
    expect(tracker.typing(), 'a key outside an editable element is not typing').toBe(false);
  });

  it('ReportsToRustAtMostOncePerInterval', () => {
    const clock = { now: 10_000, focused: true };
    let reports = 0;
    const tracker = createTypingTracker({ now: () => clock.now, focused: () => clock.focused, report: () => reports++ });
    const area = document.createElement('textarea');
    tracker.note(key(area));
    expect(reports, 'the first key reports at once').toBe(1);
    clock.now += TYPING_NOTE_INTERVAL_MS - 1;
    tracker.note(key(area));
    expect(reports).toBe(1);
    clock.now += 1;
    tracker.note(key(area));
    expect(reports).toBe(2);
    clock.now += 10 * TYPING_NOTE_INTERVAL_MS;
    tracker.note(key(area));
    expect(reports, 'after a pause the next key reports at once').toBe(3);
  });

  it('ReportsOnlyKeysThatCountAndOnlyWhileTheWindowHasFocus', () => {
    const clock = { now: 10_000, focused: false };
    let reports = 0;
    const tracker = createTypingTracker({ now: () => clock.now, focused: () => clock.focused, report: () => reports++ });
    const input = document.createElement('input');
    tracker.note(key(input));
    expect(reports, 'an unfocused window reports nothing').toBe(0);
    clock.focused = true;
    tracker.note(key(input, 's', { metaKey: true }));
    tracker.note(key(input, 'Shift'));
    tracker.note(key(document.body));
    expect(reports, 'a shortcut, a lone modifier, a key outside an editable element').toBe(0);
    tracker.note(key(input));
    expect(reports, 'the unfocused key did not start the interval').toBe(1);
  });
});
