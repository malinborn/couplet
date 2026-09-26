/**
 * ⌃Tab / ⌃⇧Tab: the next or previous tab, as a webview key.
 *
 * The menu's own keys for Show Next / Previous Tab are ⌘⇧] / ⌘⇧[. ⌃Tab was
 * the menu accelerator in 2.0.0 and never fired from the keyboard: with the
 * window key, a Ctrl-only chord goes to the WKWebView and never reaches NSMenu,
 * so the item worked by click only (measured 2026-09-25). So ⌃Tab is caught
 * here, the way ⌃1…⌃9 is (`window-number.ts`), and routed into the same path
 * the menu events take.
 */

/** ⌃Tab → 1, ⌃⇧Tab → -1, anything else → `null`. Matched on `e.code`. */
export function ctrlTab(e: KeyboardEvent): 1 | -1 | null {
  if (!e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.code !== 'Tab') return null;
  return e.shiftKey ? -1 : 1;
}

/**
 * The ⌃Tab listener. Installed in the capture phase on the window next to
 * `ctrlDigitHandler`, before the drawer's own listener, so neither the drawer
 * nor CodeMirror sees the key. Key repeat cycles on, as a held menu key does.
 */
export function ctrlTabHandler(cycle: (delta: 1 | -1) => void): (e: KeyboardEvent) => void {
  return (e) => {
    const delta = ctrlTab(e);
    if (delta === null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cycle(delta);
  };
}
