/**
 * The answer hint inside the table cell editor (math-ghost spec, "Computed
 * table cells"): while the field's text is `<expr> =` + optional spaces and
 * the caret is at its end, a muted chip `= 439.4 ⇥` sits at the field's right
 * edge. Tab writes ` 439.4` after the `=`; Esc hides the chip until the text
 * changes. The text ghost (`math/ghost.ts`) cannot serve here: the field is a
 * `<textarea>` in `document.body`, outside CodeMirror.
 *
 * `showCellEditor` (`tables.ts`) owns the keys: it asks {@link CellHint.accept}
 * on Tab and {@link CellHint.dismiss} on Escape before its own bindings, and
 * both answer `false` when no chip is shown — so without one every key does
 * exactly what it did before.
 */
import { cellHint } from '../math/cell';
import { applyTextareaEdit } from '../cell-edit-session';

export const CELL_HINT_CLASS = 'cm-md-cell-hint';

/** Space between the chip and the text, in px. */
const CHIP_GAP = 6;

/** Events after which the caret may have moved without an `input`. */
const CARET_EVENTS = ['selectionchange', 'select', 'keyup', 'mouseup', 'focus'] as const;

export interface CellHint {
  /** Re-evaluate after an edit or a caret move. Idempotent. */
  update(): void;
  /** Place the chip over the field's current box — after every reflow. */
  position(): void;
  /** Tab: write the answer if a chip is shown. `false` = no chip, key not taken. */
  accept(): boolean;
  /** Esc: hide a shown chip until the text changes. `false` = no chip, key not taken. */
  dismiss(): boolean;
  destroy(): void;
}

/** The answer to offer for this field state, or `null`. Pure. */
export function hintFor(value: string, selectionStart: number, selectionEnd: number): string | null {
  if (selectionStart !== selectionEnd || selectionEnd !== value.length) return null;
  return cellHint(value);
}

/**
 * Attach the hint to a cell editor. `onLayout` runs when the chip appears or
 * goes, since the field reserves room for it (its right padding) and has to
 * reflow.
 */
export function attachCellHint(ta: HTMLTextAreaElement, onLayout: () => void): CellHint {
  let answer: string | null = null;
  /** The text the chip was dismissed on; any other text re-evaluates. */
  let dismissedOn: string | null = null;
  let chip: HTMLElement | null = null;
  /** The field's own right padding, before the chip's room is added. */
  let basePadding: string | null = null;

  const render = (): void => {
    if (answer === null) {
      chip?.remove();
      chip = null;
      if (basePadding !== null) ta.style.paddingRight = basePadding;
      basePadding = null;
      return;
    }
    if (!chip) {
      chip = document.createElement('span');
      chip.className = CELL_HINT_CLASS;
      chip.setAttribute('aria-hidden', 'true');
      const style = getComputedStyle(ta);
      chip.style.fontFamily = style.fontFamily;
      chip.style.fontSize = style.fontSize;
      chip.style.lineHeight = style.lineHeight;
      document.body.appendChild(chip);
    }
    // `textContent`: the answer is ours, but nothing here builds markup.
    chip.textContent = `= ${answer} ⇥`;
    if (basePadding === null) basePadding = ta.style.paddingRight;
    const base = basePadding || getComputedStyle(ta).paddingRight || '0px';
    ta.style.paddingRight = `calc(${base} + ${chip.offsetWidth + CHIP_GAP}px)`;
  };

  const update = (): void => {
    if (dismissedOn !== null && ta.value !== dismissedOn) dismissedOn = null;
    const next =
      dismissedOn === null ? hintFor(ta.value, ta.selectionStart, ta.selectionEnd) : null;
    if (next === answer) return;
    answer = next;
    render();
    onLayout();
  };

  const position = (): void => {
    if (!chip) return;
    const rect = ta.getBoundingClientRect();
    const style = getComputedStyle(ta);
    const px = (v: string): number => Number.parseFloat(v) || 0;
    const right =
      rect.right - px(style.borderRightWidth) - px(basePadding || style.paddingRight);
    // On the last line — where the caret is, since the chip needs it at the end.
    const lineHeight = px(style.lineHeight) || chip.offsetHeight;
    const bottom = rect.bottom - px(style.borderBottomWidth) - px(style.paddingBottom);
    chip.style.left = `${right - chip.offsetWidth}px`;
    chip.style.top = `${bottom - lineHeight}px`;
  };

  const onCaret = (): void => update();
  for (const name of CARET_EVENTS) ta.addEventListener(name, onCaret);

  return {
    update,
    position,
    accept(): boolean {
      if (answer === null) return false;
      const value = ta.value;
      const head = value.slice(0, value.lastIndexOf('=') + 1);
      const next = `${head} ${answer}`;
      // A narrowed `insertText` — never an assignment to `value`, which would
      // wipe the field's undo stack (root CLAUDE.md). The spaces after `=`
      // collapse into the one written here.
      applyTextareaEdit(ta, next, next.length, next.length);
      update();
      return true;
    },
    dismiss(): boolean {
      if (answer === null) return false;
      dismissedOn = ta.value;
      answer = null;
      render();
      onLayout();
      return true;
    },
    destroy(): void {
      for (const name of CARET_EVENTS) ta.removeEventListener(name, onCaret);
      chip?.remove();
      chip = null;
    },
  };
}
