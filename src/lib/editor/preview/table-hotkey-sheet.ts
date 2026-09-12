import { computePosition, flip, offset, shift, size } from '@floating-ui/dom';
import { TABLE_CELL_BINDINGS, type CellBinding } from './table-keys';
import { hotkeyLabel, ariaKeyShortcuts } from '../hotkey-label';
// The chrome (`.cm-toolbar-tooltip`) is declared in this sheet, which reaches
// the bundle through `live-render/selection-toolbar.ts`. Imported here as well
// so the dependency is stated rather than inherited: this affordance is on
// every table in **both** engines, and live-preview must not depend on a
// live-render module happening to be statically imported.
import '../../../styles/live-render.css';

/**
 * The table's ⓘ — a hover cheatsheet of the cell-editing keys (#69).
 *
 * Every row comes out of `TABLE_CELL_BINDINGS`, which is the list the key
 * handler itself resolves against. Nothing here knows a key; rename one and
 * this panel renames itself. See `table-keys.ts` for why that matters.
 *
 * ## Delay: hold, but a short one
 *
 * The selection toolbar waits a full second (`toolbar-tooltip.ts`) and gives
 * the reason in its own comment: the pointer sweeps across that row of buttons
 * on the way somewhere else, so anything shorter chatters. That reason does not
 * transfer. ⓘ is a target people aim at on purpose, and this panel is the only
 * place in the app that says these keys exist — a second of nothing reads as a
 * dead icon. It still holds rather than firing instantly, because the icon sits
 * a few pixels from the ⇔ toggle and a full-size panel flashing while someone
 * reaches for that button is worse than a beat of patience.
 *
 * ## Placement: beside the table, not on top of it
 *
 * The anchor is the **table**, not the button, and the preferred placement is
 * `right-start`. Most tables are far narrower than the window, so the panel
 * lands in the empty margin beside the one it describes and covers nothing —
 * which is the whole reason not to anchor it to the ⓘ, which sits at the
 * table's top-left corner and would put the panel over the first rows.
 *
 * When there is no room to the right — a wide table, a narrow window, `full`
 * mode — `flip()` falls back **downwards**. Never up: #48 reserves the strip
 * over the header line for the column buttons, and a table at the very top of
 * the document has nothing above it at all. `top-start` is the last fallback
 * only, for a table at the very bottom of the window.
 *
 * `shift()` keeps it inside the viewport, and `size()` caps its width against
 * the space actually available, so a narrow window gets a narrower panel rather
 * than one hanging off the edge.
 *
 * It lives in `document.body`, not in the table: `.cm-md-table` carries
 * `overflow: hidden` to clip its rounded corners (#48), so a panel inside it
 * would be cut off — and a table in `full` mode can be wider than the window,
 * where being fixed to the viewport rather than to the table is what keeps the
 * panel on screen.
 *
 * ## Also reachable without a pointer
 *
 * It is a `<button>`: focus shows the panel and Escape hides it, so the keys
 * are discoverable by the people most likely to want keys.
 */

/** Short enough not to read as a dead icon, long enough not to flash. */
const OPEN_DELAY_MS = 350;

export interface HotkeySheet {
  el: HTMLElement;
  destroy(): void;
}

function keyEl(binding: CellBinding): HTMLElement {
  const kbd = document.createElement('kbd');
  kbd.className = 'cm-table-hotkeys-key';
  kbd.textContent = hotkeyLabel(binding.key);
  return kbd;
}

function buildSheet(bindings: readonly CellBinding[]): HTMLElement {
  const el = document.createElement('div');
  // Same chrome as the toolbar's hotkey tooltips — one popup look in the app.
  el.className = 'cm-toolbar-tooltip cm-table-hotkeys';
  el.setAttribute('role', 'tooltip');

  const grid = document.createElement('div');
  grid.className = 'cm-table-hotkeys-grid';
  for (const binding of bindings) {
    grid.appendChild(keyEl(binding));
    const desc = document.createElement('span');
    desc.className = 'cm-table-hotkeys-desc';
    desc.textContent = binding.description;
    if (binding.note) {
      const note = document.createElement('span');
      note.className = 'cm-table-hotkeys-note';
      note.textContent = binding.note;
      desc.appendChild(note);
    }
    grid.appendChild(desc);
  }
  el.appendChild(grid);
  return el;
}

/**
 * Build the ⓘ button and wire its panel.
 *
 * Returns the button; the panel is created on demand and always removed with
 * it, because the widget's DOM is thrown away and rebuilt on every structural
 * change to the table and a panel left in `document.body` would outlive the
 * icon it belongs to.
 */
export function createHotkeySheetButton(
  bindings: readonly CellBinding[] = TABLE_CELL_BINDINGS
): HotkeySheet {
  const btn = document.createElement('button');
  btn.className = 'cm-md-table-btn-info';
  btn.type = 'button';
  btn.textContent = 'ⓘ';
  btn.title = 'Table keyboard shortcuts';
  btn.setAttribute('aria-label', 'Table keyboard shortcuts');
  // The keys themselves, for a screen reader that will never see the panel.
  btn.setAttribute(
    'aria-keyshortcuts',
    bindings.map((b) => ariaKeyShortcuts(b.key)).join(' ')
  );

  let panel: HTMLElement | null = null;
  let timer: number | undefined;

  const hide = (): void => {
    window.clearTimeout(timer);
    timer = undefined;
    panel?.remove();
    panel = null;
  };

  const show = (): void => {
    if (panel || !btn.isConnected) return;
    const el = buildSheet(bindings);
    document.body.appendChild(el);
    panel = el;

    // The table if we can reach it, the button otherwise — the fallback matters
    // only for a panel built outside a widget, i.e. in a test.
    const anchor = btn.closest<HTMLElement>('.cm-md-table-wrap') ?? btn;

    void computePosition(anchor, el, {
      placement: 'right-start',
      middleware: [
        offset(10),
        flip({ fallbackPlacements: ['bottom-start', 'bottom-end', 'top-start'] }),
        shift({ padding: 8 }),
        size({
          padding: 8,
          apply({ availableWidth, elements }) {
            // A narrow window gets a narrower panel, not a panel off the edge.
            elements.floating.style.maxWidth = `${Math.max(200, Math.min(340, availableWidth))}px`;
          },
        }),
      ],
    }).then(({ x, y }) => {
      if (panel !== el) return;
      Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
      // Revealed only once it has a real position — otherwise it paints one
      // frame in the window's top-left corner, as the toolbar tooltips did.
      el.dataset.placed = 'true';
    });
  };

  const schedule = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(show, OPEN_DELAY_MS);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && panel) {
      e.stopPropagation();
      hide();
      btn.blur();
    }
  };

  btn.addEventListener('mouseenter', schedule);
  btn.addEventListener('mouseleave', hide);
  btn.addEventListener('focus', show);
  btn.addEventListener('blur', hide);
  btn.addEventListener('keydown', onKeyDown);
  // A click would otherwise start a selection in the editor behind the table.
  btn.addEventListener('mousedown', (e) => e.preventDefault());

  return {
    el: btn,
    destroy() {
      btn.removeEventListener('mouseenter', schedule);
      btn.removeEventListener('mouseleave', hide);
      btn.removeEventListener('focus', show);
      btn.removeEventListener('blur', hide);
      btn.removeEventListener('keydown', onKeyDown);
      hide();
    },
  };
}

/** Removes any panel left behind by a widget whose DOM was replaced. */
export function clearHotkeySheets(): void {
  document.querySelectorAll('.cm-table-hotkeys').forEach((el) => el.remove());
}
