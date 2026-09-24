/**
 * "The human is typing" (spec §5: an agent never takes the active tab while
 * they type): a key that went into an editable element of this window within
 * the last TYPING_GRACE_MS, while the window has keyboard focus. 2 s covers
 * the pause between words without holding the guard up for someone who has
 * stopped to read.
 */
export const TYPING_GRACE_MS = 2000;

export function isEditableTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target instanceof Element && target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

const MODIFIER_KEYS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'AltGraph', 'CapsLock', 'Fn']);

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'target'>;

/** A keystroke that edits text: into an editable element, not a shortcut, not a lone modifier. */
export function countsAsTyping(e: KeyLike): boolean {
  return !e.metaKey && !e.ctrlKey && !MODIFIER_KEYS.has(e.key) && isEditableTarget(e.target);
}

export function isHumanTyping(s: { focused: boolean; lastTypedAt: number; now: number }): boolean {
  return s.focused && s.lastTypedAt > 0 && s.now - s.lastTypedAt < TYPING_GRACE_MS;
}

/** The window's typing clock: `note` every keydown (capture phase), ask `typing()`. */
export function createTypingTracker(deps: { now(): number; focused(): boolean }) {
  let lastTypedAt = 0;
  return {
    note(e: KeyLike): void {
      if (countsAsTyping(e)) lastTypedAt = deps.now();
    },
    typing(): boolean {
      return isHumanTyping({ focused: deps.focused(), lastTypedAt, now: deps.now() });
    },
  };
}
