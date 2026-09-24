/**
 * Changing a window's `#N` from the notch (spec §3). The decision is Rust's
 * (`window_set_number`, under the registry lock); this is the window's side.
 */

import type { ToastPayload } from '../toasts.svelte';

/** `window_set_number`'s answer. */
export type RenumberResult = 'set' | 'taken' | 'invalid';

/** How long a click on `#N` waits for a second one while the drawer is open. */
export const DOUBLE_CLICK_MS = 400;

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
