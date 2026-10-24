import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { Decoration, EditorView, WidgetType, keymap, type Command } from '@codemirror/view';
import { isHumanEdit } from '../human-edit';
import { findExpression, type Candidate } from './trigger';

/**
 * The answer offered after `338 * 1.3 =`: grey text at the caret, Tab writes
 * it in, Esc hides it (spec 2026-10-24-math-ghost-design.md).
 *
 * Recomputed on every human edit and only then — an agent's text, a reload, a
 * caret move or a composition step never shows one. Esc hides it until the
 * next human edit, so a space after `=` (or retyping `=`) brings it back.
 */

const setMathGhost = StateEffect.define<Candidate | null>();

export const mathGhostField = StateField.define<Candidate | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setMathGhost)) return effect.value;
    if (isHumanEdit({ docChanged: tr.docChanged, transactions: [tr] })) {
      if (tr.isUserEvent('input.type.compose')) return null;
      const { ranges, main } = tr.state.selection;
      if (ranges.length !== 1 || !main.empty) return null;
      return findExpression(tr.state, main.head);
    }
    return tr.docChanged || tr.selection ? null : value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (ghost) =>
      ghost
        ? Decoration.set([
            Decoration.widget({ widget: new GhostWidget(ghostText(ghost)), side: 1 }).range(ghost.pos),
          ])
        : Decoration.none
    ),
});

/** What the ghost shows: a space when the human typed none after `=`. */
function ghostText(ghost: Candidate): string {
  return (ghost.pos === ghost.eq ? ' ' : '') + ghost.answer;
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-math-ghost';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = this.text;
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** Tab: `=` plus whatever spaces followed it becomes `= <answer>`. Its own undo step. */
export const acceptMathGhost: Command = (view) => {
  const ghost = view.state.field(mathGhostField, false);
  if (!ghost) return false;
  const insert = ' ' + ghost.answer;
  view.dispatch({
    changes: { from: ghost.eq, to: ghost.pos, insert },
    selection: { anchor: ghost.eq + insert.length },
    effects: setMathGhost.of(null),
    annotations: isolateHistory.of('full'),
    userEvent: 'input.complete',
    scrollIntoView: true,
  });
  return true;
};

/** Esc: hide the ghost. Not taken when there is none (AI highlights, search keep Esc). */
export const dismissMathGhost: Command = (view) => {
  if (!view.state.field(mathGhostField, false)) return false;
  view.dispatch({ effects: setMathGhost.of(null) });
  return true;
};

export function mathGhost(): Extension {
  return [
    mathGhostField,
    // Prec.highest so Tab is ours before list indent — but only while a ghost
    // is shown; the commands return false otherwise and Tab falls through.
    Prec.highest(
      keymap.of([
        { key: 'Tab', run: acceptMathGhost },
        { key: 'Escape', run: dismissMathGhost },
      ])
    ),
    EditorView.focusChangeEffect.of((state, focusing) =>
      !focusing && state.field(mathGhostField, false) ? setMathGhost.of(null) : null
    ),
  ];
}
