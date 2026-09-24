/**
 * "The human is typing" (spec §5: an agent never takes the active tab while
 * they type): a key that went into an editable element of this window within
 * the last TYPING_GRACE_MS, while the window has keyboard focus. 2 s covers
 * the pause between words without holding the guard up for someone who has
 * stopped to read. Mirrored in src-tauri/src/typing.rs.
 */
export const TYPING_GRACE_MS = 2000;

/**
 * A window also tells Rust it is being typed in (`note_typing`), at most this
 * often: the rule above sees only its own window, and an agent's command for
 * another one would bring that window forward mid-word (tabs-questions Q10).
 * Mirrored in src-tauri/src/typing.rs, which widens its grace by it.
 */
export const TYPING_NOTE_INTERVAL_MS = 500;

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

/**
 * The window's typing clock: `note` every keydown (capture phase), ask
 * `typing()`. `report` tells Rust (`note_typing`): only for a key that counts,
 * only while the window has focus, at most once per TYPING_NOTE_INTERVAL_MS.
 */
export function createTypingTracker(deps: { now(): number; focused(): boolean; report?(): void }) {
  let lastTypedAt = 0;
  let lastReportedAt: number | null = null;
  return {
    note(e: KeyLike): void {
      if (!countsAsTyping(e)) return;
      const now = deps.now();
      lastTypedAt = now;
      if (!deps.report || !deps.focused()) return;
      if (lastReportedAt !== null && now - lastReportedAt < TYPING_NOTE_INTERVAL_MS) return;
      lastReportedAt = now;
      deps.report();
    },
    typing(): boolean {
      return isHumanTyping({ focused: deps.focused(), lastTypedAt, now: deps.now() });
    },
  };
}
