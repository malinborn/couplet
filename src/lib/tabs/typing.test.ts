// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { countsAsTyping, createTypingTracker, isEditableTarget, isHumanTyping, TYPING_GRACE_MS } from './typing';

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
});
