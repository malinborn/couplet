/**
 * Making text inside a CM6 widget selectable with the mouse.
 *
 * A widget's DOM lives in a `contenteditable="false"` island inside the
 * `contenteditable="true"` content, and Chrome treats such an island as one
 * atomic thing: a drag that starts inside it selects the whole island (or
 * nothing) instead of the words under the pointer. Measured in a browser on
 * a live-render table: `user-select: text`, `-webkit-user-modify: read-only`,
 * `contenteditable="plaintext-only"` and `user-select: all` all leave the
 * selection empty. The only thing that selects at all is a **nested editing
 * host** — the text element becoming `contenteditable="true"` itself (#28,
 * #31).
 *
 * That makes the text editable, which it must not be: CM6 does not own this
 * DOM, so anything typed there would go nowhere and vanish on the next
 * decoration rebuild. So every route to an actual edit is refused.
 * `beforeinput` covers typing, paste, cut and delete in one place — it fires
 * before the DOM is touched, so nothing has to be undone afterwards.
 *
 * The caret is hidden in CSS (`caret-color: transparent`) rather than here: a
 * blinking caret in text that cannot be typed into would be a lie, while the
 * selection highlight is exactly what we are after.
 *
 * The widget must additionally return `true` from `ignoreEvent()` for events
 * originating in this subtree, or CM6's own mouse handling claims the drag
 * and snaps the selection out to the whole widget range before the browser
 * ever gets to draw one.
 */
export function makeWidgetTextSelectable(el: HTMLElement): void {
  el.setAttribute('contenteditable', 'true');
  el.setAttribute('spellcheck', 'false');
  // Read-only in every respect but selection.
  el.addEventListener('beforeinput', (event) => event.preventDefault());
  el.addEventListener('dragstart', (event) => event.preventDefault());
}

/**
 * Whether a DOM event originated inside an element matching `selector`.
 *
 * `event.target` is a text node for some event types, and `closest` only
 * exists on elements, so the lookup has to start from the nearest element.
 */
export function eventInside(event: Event, selector: string): boolean {
  const target = event.target;
  if (!(target instanceof Node)) return false;
  const el = target instanceof Element ? target : target.parentElement;
  return el ? el.closest(selector) !== null : false;
}
