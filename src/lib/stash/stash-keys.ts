/**
 * ⌃T puts the active document away and ⌃S opens or closes the stash (stash
 * spec «Клавиатура»), as webview keys. A Ctrl-only menu accelerator never
 * fires from the keyboard — the WKWebView takes the chord before NSMenu
 * (CLAUDE.md, measured 2026-09-25) — so both are caught here, like ⌃Tab
 * (`tabs/tab-cycle-keys.ts`), and File → «Отложить в тайник» and View → Tabs →
 * «Тайник» have no key. ⌃T takes CodeMirror's (and Cocoa's) `transposeChars`
 * on purpose.
 */

/** ⌃T by the physical key (any layout), ⌃ alone. */
export function isCtrlT(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyT';
}

/** ⌃S by the physical key (any layout), ⌃ alone — ⌘S stays Save. */
export function isCtrlS(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyS';
}

/**
 * The listener — one for both keys. Installed in the capture phase on the
 * window right after `ctrlTabHandler` (App's `onMount`), before the drawer's
 * own listener, so neither the drawer nor CodeMirror sees the key.
 * `toggleStash` is optional until the app wires the stash drawer: without it
 * ⌃S is not claimed and passes through untouched.
 */
export function stashKeysHandler(actions: { putAway(): void; toggleStash?(): void }): (e: KeyboardEvent) => void {
  return (e) => {
    const ctrlT = isCtrlT(e);
    if (!ctrlT && !(isCtrlS(e) && actions.toggleStash)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // A held ⌃T would put away tab after tab (D7) and a held ⌃S would flap the
    // drawer; an IME composing owns the key.
    if (e.repeat || e.isComposing) return;
    if (ctrlT) actions.putAway();
    else actions.toggleStash?.();
  };
}
