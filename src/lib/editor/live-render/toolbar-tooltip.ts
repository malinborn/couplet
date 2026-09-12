import { computePosition, flip, offset, shift } from '@floating-ui/dom';

/**
 * Hotkey tooltips for the selection toolbar (#56).
 *
 * The toolbar is how most people will ever find out that bold has a key at
 * all, so each button says so after the pointer has rested on it for a beat.
 *
 * Deliberately knows nothing about which buttons exist or what they do: it
 * reads `data-tooltip` off whatever buttons the popup contains. `buildPopup`
 * owns the captions, and pulls the key half of them out of the binding table
 * in `keybindings.ts`.
 */

/** Owner's starting value: long enough that sweeping the row stays silent. */
const OPEN_DELAY_MS = 1000;

/**
 * How long "I am reading the toolbar" survives leaving a button.
 *
 * Once one tooltip has been shown, the neighbours appear immediately — waiting
 * a second again to compare B with I is the behaviour that makes tooltips feel
 * broken. The session ends shortly after the pointer leaves the row, so coming
 * back later starts from the full delay again.
 */
const SESSION_GRACE_MS = 500;

export interface TooltipHost {
  /**
   * Which side to prefer, following the toolbar's own final placement: a
   * tooltip on the same side as the selection would cover the very text the
   * toolbar is about to format.
   */
  setPlacement(placement: 'top' | 'bottom'): void;
  hide(): void;
  destroy(): void;
}

export function attachHotkeyTooltips(popup: HTMLElement): TooltipHost {
  let tip: HTMLElement | null = null;
  let openTimer: number | undefined;
  let sessionTimer: number | undefined;
  let sessionActive = false;
  let placement: 'top' | 'bottom' = 'top';

  const hide = (): void => {
    window.clearTimeout(openTimer);
    openTimer = undefined;
    tip?.remove();
    tip = null;
  };

  const show = (btn: HTMLElement): void => {
    const text = btn.dataset.tooltip;
    if (!text || !btn.isConnected) return;
    hide();
    sessionActive = true;

    const el = document.createElement('div');
    el.className = 'cm-toolbar-tooltip';
    el.setAttribute('role', 'tooltip');
    el.textContent = text;
    document.body.appendChild(el);
    tip = el;

    void computePosition(btn, el, {
      placement,
      middleware: [offset(8), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      // The pointer may have moved on while computePosition was pending.
      if (tip !== el) return;
      Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
      // Revealed only once it has a real position, so it never flashes at the
      // top-left corner on the way to where it belongs.
      el.dataset.placed = 'true';
    });
  };

  const onOver = (e: Event): void => {
    const btn = (e.target as Element | null)?.closest<HTMLElement>('.cm-selection-toolbar-btn');
    if (!btn || !popup.contains(btn)) return;
    window.clearTimeout(sessionTimer);
    window.clearTimeout(openTimer);
    if (tip) hide();
    openTimer = window.setTimeout(() => show(btn), sessionActive ? 0 : OPEN_DELAY_MS);
  };

  const onOut = (e: Event): void => {
    const to = (e as MouseEvent).relatedTarget as Node | null;
    if (to && popup.contains(to)) return; // moving between buttons — `onOver` takes it
    hide();
    window.clearTimeout(sessionTimer);
    sessionTimer = window.setTimeout(() => {
      sessionActive = false;
    }, SESSION_GRACE_MS);
  };

  // A click has already told the user what the button does; a caption left
  // hanging over the result is just in the way.
  const onDown = (): void => {
    hide();
    sessionActive = false;
  };

  popup.addEventListener('mouseover', onOver);
  popup.addEventListener('mouseout', onOut);
  popup.addEventListener('mousedown', onDown, true);

  return {
    setPlacement(next) {
      placement = next;
    },
    hide,
    destroy() {
      popup.removeEventListener('mouseover', onOver);
      popup.removeEventListener('mouseout', onOut);
      popup.removeEventListener('mousedown', onDown, true);
      window.clearTimeout(sessionTimer);
      hide();
      sessionActive = false;
    },
  };
}
