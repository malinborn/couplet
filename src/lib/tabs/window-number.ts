/**
 * Window numbers from the window's side (spec §3): renaming `#N` from the
 * notch (`window_set_number`, decided under the registry lock) and ⌃1…⌃9
 * (`window_reveal_number`).
 */

import type { ToastPayload } from '../toasts.svelte';

/** `window_set_number`'s answer. */
export type RenumberResult = 'set' | 'taken' | 'invalid';

/**
 * How long a click on `#N` waits for a second one while the drawer is open.
 * macOS's default double-click speed; a page cannot read the user's setting,
 * so a slower double-click reads as two clicks.
 */
export const DOUBLE_CLICK_MS = 500;

/** How long «Номер #N занят» and «Окна #N нет» stay. */
export const WINDOW_NUMBER_TOAST_MS = 3000;

/** The notch input's text as a window number: one or two digits, 1–99. */
export function parseWindowNumber(draft: string): number | null {
  if (!/^\d{1,2}$/.test(draft)) return null;
  const n = Number(draft);
  return n >= 1 && n <= 99 ? n : null;
}

export interface RenumberDeps {
  setNumber(number: number): Promise<RenumberResult>;
  /** The window shows its new number (title, notch, drawer head). */
  apply(number: number): void;
  toast(payload: ToastPayload): void;
}

/**
 * Ask for `number`; show it on success, say so when another window has it.
 * A failed IPC changes nothing and answers `invalid`: the input shakes.
 */
export async function renumberWindow(number: number, deps: RenumberDeps): Promise<RenumberResult> {
  let result: RenumberResult;
  try {
    result = await deps.setNumber(number);
  } catch (e) {
    console.error('window_set_number failed:', e);
    return 'invalid';
  }
  if (result === 'set') deps.apply(number);
  else if (result === 'taken') deps.toast({ kind: 'window-number', reason: 'taken', number });
  return result;
}

/** `window_reveal_number`'s answer. */
export type RevealResult = 'revealed' | 'missing' | 'current';

/**
 * ⌃1…⌃9 → the window number; `null` for any other key. Matched on `e.code`,
 * layout independent. ⌘1…⌘9 (tabs) and ⌃Tab are not this.
 */
export function ctrlDigit(e: KeyboardEvent): number | null {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  const m = /^Digit([1-9])$/.exec(e.code);
  return m ? Number(m[1]) : null;
}

export interface RevealDeps {
  /** This window's `#N`. */
  current(): number | null;
  reveal(number: number): Promise<RevealResult>;
  toast(payload: ToastPayload): void;
}

/** Bring `#number` forward; «Окна #N нет» when there is none. Its own number does nothing. */
export async function revealWindowNumber(number: number, deps: RevealDeps): Promise<void> {
  if (deps.current() === number) return;
  let result: RevealResult;
  try {
    result = await deps.reveal(number);
  } catch (e) {
    console.error('window_reveal_number failed:', e);
    return;
  }
  if (result === 'missing') deps.toast({ kind: 'window-number', reason: 'missing', number });
}

/**
 * The ⌃1…⌃9 listener. Installed in the capture phase on the window before the
 * drawer's own listener, so it runs first and neither the drawer nor
 * CodeMirror sees the key.
 */
export function ctrlDigitHandler(deps: RevealDeps): (e: KeyboardEvent) => void {
  return (e) => {
    const n = ctrlDigit(e);
    if (n === null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) void revealWindowNumber(n, deps);
  };
}
