/**
 * ⌃T: put the active document away (stash spec «Клавиатура»), as a webview
 * key. A Ctrl-only menu accelerator never fires from the keyboard — the
 * WKWebView takes the chord before NSMenu (CLAUDE.md, measured 2026-09-25) —
 * so it is caught here, like ⌃Tab (`tabs/tab-cycle-keys.ts`), and File →
 * «Отложить в тайник» has no key. Takes CodeMirror's (and Cocoa's)
 * `transposeChars` on purpose. ⌃S (open the stash) joins this handler in
 * stage 04.
 */

/** ⌃T by the physical key (any layout), ⌃ alone. */
export function isCtrlT(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyT';
}

/**
 * The listener. Installed in the capture phase on the window right after
 * `ctrlTabHandler` (App's `onMount`), before the drawer's own listener, so
 * neither the drawer nor CodeMirror sees the key.
 */
export function stashKeysHandler(actions: { putAway(): void }): (e: KeyboardEvent) => void {
  return (e) => {
    if (!isCtrlT(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // A held ⌃T would put away tab after tab (D7); an IME composing owns the key.
    if (e.repeat || e.isComposing) return;
    actions.putAway();
  };
}
