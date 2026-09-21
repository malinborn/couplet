import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { t } from '../i18n';

/**
 * One pending `mdmini ask` question. Rendered as a widget in the document —
 * never inserted into the document text, so it must never be autosaved. The
 * socket call behind an ask blocks until `onAnswer` fires (a button click) or
 * the widget is removed by a timeout/dismiss, at which point the caller
 * reports the answer back over `ai_respond`.
 */
export interface AskSpec {
  id: number;
  question: string;
  options: string[];
  /** Single-choice (click an option) vs multi-choice (toggle chips, confirm). */
  multi: boolean;
  /** Renders a free-text input below the option row, in either mode. */
  freeText: boolean;
  /**
   * Fires once, in one of five shapes:
   * - `string` — single-choice: the clicked option's text.
   * - `string[]` — multi-choice confirm, free-text field left empty
   *   (possibly `[]`, a valid, explicit "none selected").
   * - `{ custom: string }` — single-choice: Enter in the free-text field
   *   with a non-empty trimmed value.
   * - `{ answers: string[]; custom: string }` — multi-choice confirm with a
   *   non-empty trimmed value in the free-text field.
   * - `null` — dismiss, in any mode.
   */
  onAnswer: (
    id: number,
    result: string | string[] | { custom: string } | { answers: string[]; custom: string } | null
  ) => void;
}

/** Adds an ask widget, anchored at the end of the line containing `pos`. */
export const addAiAsk = StateEffect.define<{ spec: AskSpec; pos: number }>();

/** Removes the ask widget with the given id. A no-op if that id isn't present
 * (e.g. the stale-widget cleanup timer racing an already-answered click). */
export const removeAiAsk = StateEffect.define<number>();

/** Exported for tests: `eq()` structural comparison and `toDOM()` wiring. */
export class AskWidget extends WidgetType {
  /**
   * Multi-choice selection state. Lives on the widget instance, not in CM6
   * state: toggling a chip must never dispatch a transaction (that would
   * rebuild decorations on every click), so it mutates this set and the
   * chip's DOM directly. `eq()` deliberately excludes it — reusing the same
   * widget instance across unrelated document edits keeps the selection.
   */
  private readonly selected = new Set<string>();

  constructor(readonly spec: AskSpec) {
    super();
  }

  eq(other: AskWidget): boolean {
    return (
      this.spec.id === other.spec.id &&
      this.spec.question === other.spec.question &&
      this.spec.multi === other.spec.multi &&
      this.spec.freeText === other.spec.freeText &&
      this.spec.options.length === other.spec.options.length &&
      this.spec.options.every((option, i) => option === other.spec.options[i])
    );
  }

  toDOM(): HTMLElement {
    const { id, question, options, multi, freeText, onAnswer } = this.spec;

    // CM6 measures a block widget's height from its root element's DOM box —
    // which does NOT include CSS margin. A margin on the widget root (as
    // `.cm-ai-ask` used to carry) still visually pushes every line below it
    // down, but CM6's height map doesn't know that, so it drifts out of sync
    // with the real DOM by exactly the margin — and posAtCoords's vertical
    // scan (which compares the height map against measured line rects) walks
    // straight past every line below the widget. Padding IS included in the
    // box, so the vertical spacing lives on this outer wrapper's padding
    // instead, and `.cm-ai-ask` itself carries no margin.
    const wrap = document.createElement('div');
    wrap.className = 'cm-ai-ask-wrap';

    const card = document.createElement('div');
    card.className = 'cm-ai-ask';

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'cm-ai-ask-dismiss';
    dismiss.setAttribute('aria-label', t('editor.ai_ask.dismiss'));
    dismiss.textContent = '✕';
    // Keep the editor selection from moving to a click in the widget.
    dismiss.addEventListener('mousedown', (event) => event.preventDefault());
    dismiss.addEventListener('click', () => onAnswer(id, null));
    card.appendChild(dismiss);

    const questionEl = document.createElement('div');
    questionEl.className = 'cm-ai-ask-question';
    questionEl.textContent = question;
    if (multi) {
      // A monochrome/colorblind-safe cue that survives even if the checkbox
      // marker below is missed — spelled out next to the question itself.
      const modeHint = document.createElement('span');
      modeHint.className = 'cm-ai-ask-mode';
      modeHint.textContent = t('editor.ai_ask.multi_hint');
      questionEl.appendChild(modeHint);
    }
    card.appendChild(questionEl);

    const optionsRow = document.createElement('div');
    // `cm-ai-ask-multi` gives unchecked chips a leading empty-checkbox
    // marker via CSS, so a multi-choice ask doesn't look identical to a
    // single-choice one before the first click.
    optionsRow.className = multi ? 'cm-ai-ask-options cm-ai-ask-multi' : 'cm-ai-ask-options';

    // Built up front (if requested) so the multi-choice confirm handler
    // below can read its value; appended to the card last regardless, so it
    // always lands below the option row.
    let input: HTMLInputElement | undefined;
    if (freeText) {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'cm-ai-ask-input';
      input.placeholder = t('editor.ai_ask.placeholder');
      // ignoreEvent() (below) only tells CM6's own handling to leave widget
      // events alone — it does not stop the DOM event from bubbling past
      // contentDOM to document-level listeners (e.g. the Escape-clears-
      // highlights keymap, or table.ts's own `document.addEventListener`
      // Escape handlers). A real, focusable, editable input needs an
      // explicit stopPropagation on every key event, or typing in it would
      // trigger those handlers. mousedown must stop propagation too, but
      // NOT preventDefault — preventDefault there would block the browser
      // from focusing/placing the caret in the input at all.
      input.addEventListener('mousedown', (event) => event.stopPropagation());
      input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (multi || event.key !== 'Enter') return;
        const text = input!.value.trim();
        if (text) onAnswer(id, { custom: text });
      });
      input.addEventListener('keypress', (event) => event.stopPropagation());
      input.addEventListener('keyup', (event) => event.stopPropagation());
    }

    if (multi) {
      for (const option of options) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'cm-ai-ask-option';
        chip.setAttribute('aria-pressed', 'false');
        chip.textContent = option;
        chip.addEventListener('mousedown', (event) => event.preventDefault());
        chip.addEventListener('click', () => {
          const nowSelected = !this.selected.has(option);
          if (nowSelected) {
            this.selected.add(option);
          } else {
            this.selected.delete(option);
          }
          chip.setAttribute('aria-pressed', String(nowSelected));
          chip.className = nowSelected ? 'cm-ai-ask-option cm-ai-ask-chip-checked' : 'cm-ai-ask-option';
        });
        optionsRow.appendChild(chip);
      }

      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'cm-ai-ask-confirm';
      confirm.textContent = t('editor.ai_ask.ok');
      confirm.addEventListener('mousedown', (event) => event.preventDefault());
      confirm.addEventListener('click', () => {
        const answers = options.filter((option) => this.selected.has(option));
        const text = input?.value.trim();
        onAnswer(id, text ? { answers, custom: text } : answers);
      });
      optionsRow.appendChild(confirm);
    } else {
      for (const option of options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cm-ai-ask-option';
        button.textContent = option;
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', () => onAnswer(id, option));
        optionsRow.appendChild(button);
      }
    }
    card.appendChild(optionsRow);
    if (input) card.appendChild(input);

    wrap.appendChild(card);
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function isAskWidget(widget: WidgetType): widget is AskWidget {
  return widget instanceof AskWidget;
}

/**
 * Holds one block widget per pending `ask`, each carrying its own `AskSpec`
 * (multiple concurrent asks coexist, keyed by id). Widgets are anchored at a
 * line boundary — the end of the line containing the requested position — so
 * inserting one never splits a table or mermaid block line. Ranges map
 * through edits like `aiHighlightField`, so a widget stays attached to its
 * line as the user types elsewhere.
 */
export const aiAskField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(addAiAsk)) {
        const { spec, pos } = effect.value;
        const clamped = Math.max(0, Math.min(pos, tr.state.doc.length));
        const anchor = tr.state.doc.lineAt(clamped).to;
        const widget = Decoration.widget({ widget: new AskWidget(spec), block: true, side: 1 });
        deco = deco.update({ add: [widget.range(anchor)] });
      } else if (effect.is(removeAiAsk)) {
        const id = effect.value;
        deco = deco.update({
          filter: (_from, _to, value) => !(isAskWidget(value.spec.widget) && value.spec.widget.spec.id === id),
        });
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Ids of all currently-active ask widgets, in document order. */
export function activeAskIds(state: EditorState): number[] {
  const set = state.field(aiAskField, false);
  if (!set) return [];
  const ids: number[] = [];
  set.between(0, state.doc.length, (_from, _to, value) => {
    if (isAskWidget(value.spec.widget)) ids.push(value.spec.widget.spec.id);
  });
  return ids;
}
