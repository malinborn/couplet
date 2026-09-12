/**
 * The editor half of #30: notice JSON arriving on a paste, and expand it on
 * request. Detection itself lives in `json-format.ts` and is pure.
 *
 * Nothing here ever reformats the document on its own. A paste only *offers*;
 * the change is applied by an explicit click, hotkey or menu item, in a single
 * ordinary transaction, so one Cmd+Z puts it back.
 */

import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view';
import { planJsonFormat } from './json-fence';

/** Range of a pending offer, in current document coordinates. */
export interface JsonOffer {
  from: number;
  to: number;
}

export const setJsonOffer = StateEffect.define<JsonOffer>();
export const clearJsonOffer = StateEffect.define<null>();

/**
 * The pending offer, or null.
 *
 * A StateField rather than a variable because the range has to survive edits
 * elsewhere in the document: the user pastes JSON, types a sentence above it,
 * and the offer must still point at the JSON. `mapPos` with the two sides
 * pushed outward keeps the range covering the same text.
 */
export const jsonOfferField = StateField.define<JsonOffer | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setJsonOffer)) return effect.value;
      if (effect.is(clearJsonOffer)) return null;
    }
    if (!value) return null;
    if (!tr.docChanged) return value;
    const from = tr.changes.mapPos(value.from, -1);
    const to = tr.changes.mapPos(value.to, 1);
    return to > from ? { from, to } : null;
  },
});

/** The text a pending offer currently covers, or null if there is no offer. */
export function offeredText(view: EditorView): string | null {
  const offer = view.state.field(jsonOfferField, false);
  if (!offer) return null;
  if (offer.to > view.state.doc.length) return null;
  return view.state.sliceDoc(offer.from, offer.to);
}

/**
 * Apply the pending offer. Returns false if there is nothing to apply —
 * including the case where the text stopped being JSON after further edits.
 *
 * The change itself comes from `planJsonFormat`, which also decides the
 * trimmed span and whether a ```json fence goes around the result (#47a).
 * One change, one transaction, one Cmd+Z.
 */
export function applyJsonOffer(view: EditorView): boolean {
  const offer = view.state.field(jsonOfferField, false);
  if (!offer || offeredText(view) === null) return false;

  const plan = planJsonFormat(view.state, offer.from, offer.to);
  if (plan === null) {
    view.dispatch({ effects: clearJsonOffer.of(null) });
    return false;
  }

  view.dispatch({
    changes: { from: plan.from, to: plan.to, insert: plan.insert },
    effects: clearJsonOffer.of(null),
    userEvent: 'input.format.json',
  });
  return true;
}

/** Drop the pending offer without applying it (the toast's close button). */
export function dismissJsonOffer(view: EditorView): void {
  if (view.state.field(jsonOfferField, false)) {
    view.dispatch({ effects: clearJsonOffer.of(null) });
  }
}

/**
 * The hotkey / menu action: expand the selection if there is one, otherwise
 * the whole document.
 *
 * Falling back to the whole document is what makes this useful for the
 * originating scenario — a file that *is* one JSON line, opened from disk,
 * where there was no paste to hang an offer on.
 */
export function formatJsonCommand(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const hasSelection = !sel.empty;
  const from = hasSelection ? sel.from : 0;
  const to = hasSelection ? sel.to : state.doc.length;

  const plan = planJsonFormat(state, from, to);
  if (plan === null) return false;

  view.dispatch({
    changes: { from: plan.from, to: plan.to, insert: plan.insert },
    effects: clearJsonOffer.of(null),
    userEvent: 'input.format.json',
  });
  return true;
}

/** True when the hotkey would do something — used to grey nothing, only to test. */
export function canFormatJson(view: EditorView): boolean {
  const sel = view.state.selection.main;
  const from = sel.empty ? 0 : sel.from;
  const to = sel.empty ? view.state.doc.length : sel.to;
  return planJsonFormat(view.state, from, to) !== null;
}

export const jsonFormatKeymap: Extension = keymap.of([
  {
    // Free at the time of writing: Cmd+Shift+M is the comment, Cmd+Shift+T the
    // session, Cmd+Shift+S save-as. Mirrored by the Edit menu item, so a user
    // who never learns the chord still has a way in.
    key: 'Mod-Shift-j',
    run: formatJsonCommand,
    preventDefault: true,
  },
]);

/**
 * Watch for pasted JSON and report it to the window shell, which raises the
 * toast.
 *
 * Per-window callbacks, so this is appended in `Editor.svelte` alongside the
 * other notifiers rather than living in the shared `createExtensions()` list.
 *
 * Why the userEvent and not a `paste` DOM handler: CodeMirror tags its own
 * paste transaction `input.paste`, which means we see the text *as inserted*,
 * after whatever normalisation the view did — so the range we offer and the
 * text we analysed cannot disagree.
 */
export function jsonPasteNotifier(callbacks: {
  onOffer: () => void;
  onWithdraw: () => void;
}): Extension {
  return ViewPlugin.fromClass(
    class {
      constructor(private view: EditorView) {}

      update(update: ViewUpdate): void {
        if (!update.docChanged) return;

        const pasted = update.transactions.some((tr) => tr.isUserEvent('input.paste'));
        if (pasted) {
          this.considerPaste(update);
          return;
        }

        // An existing offer can be edited into something that is no longer
        // JSON. Withdraw rather than leave a button that silently does nothing.
        const offer = update.state.field(jsonOfferField, false);
        if (offer) {
          if (!planJsonFormat(update.state, offer.from, offer.to)) {
            queueMicrotask(() => {
              this.view.dispatch({ effects: clearJsonOffer.of(null) });
              callbacks.onWithdraw();
            });
          }
        }
      }

      private considerPaste(update: ViewUpdate): void {
        let from = -1;
        let to = -1;
        update.changes.iterChanges((_fromA, _toA, fromB, toB) => {
          if (from === -1 || fromB < from) from = fromB;
          if (toB > to) to = toB;
        });
        if (from === -1 || to <= from) return;

        // `planJsonFormat` answers the whole question: not JSON, or JSON that
        // is already expanded *and* already fenced, both come back null. Note
        // that already-expanded JSON pasted bare into markdown is NOT nothing
        // to do — it still needs its fence (#47a) — so this is a wider offer
        // than the text-only check it replaces.
        if (!planJsonFormat(update.state, from, to)) {
          if (update.state.field(jsonOfferField, false)) {
            queueMicrotask(() => {
              this.view.dispatch({ effects: clearJsonOffer.of(null) });
              callbacks.onWithdraw();
            });
          }
          return;
        }

        // Dispatching from inside `update` is not allowed; defer by a
        // microtask so this lands as its own transaction.
        queueMicrotask(() => {
          this.view.dispatch({ effects: setJsonOffer.of({ from, to }) });
          callbacks.onOffer();
        });
      }
    }
  );
}
