import { EditorView } from '@codemirror/view';
import { EditorState, StateEffect, StateField, type Extension, type StateEffectType } from '@codemirror/state';
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  completionStatus,
  currentCompletions,
  selectedCompletion,
  setSelectedCompletion,
  startCompletion,
} from '@codemirror/autocomplete';

/**
 * Shared machinery behind every "slash command opens a second completion
 * step" picker (`/theme`, `/tone`). Extracted from what used to be
 * `slash-theme.ts` alone, once a second picker needed the exact same
 * anchor-tracking, initial-selection-correction and abort handling — the
 * details here (the `placing` guard, the `wasOpenBefore` check, the
 * queueMicrotask deferrals) are all the product of real bugs, not style
 * choices, so they live once and get reused rather than re-derived per
 * picker. See `slash-theme.ts` and `slash-tone.ts` for the two concrete uses.
 */

export interface PickerFieldState {
  readonly anchor: number;
  /**
   * `false` from the moment the picker opens until the initial-selection
   * correction below has landed. While `false`, `preview` (if the caller
   * supplied one) must not be called at all — CM6 auto-selects its first
   * sorted option the instant the list becomes active, regardless of what is
   * on screen or saved, and calling `preview` on that would flash it for one
   * frame before the correction lands.
   */
  readonly selectionPlaced: boolean;
}

/**
 * One instance per picker *kind* (`/theme`'s family picker, `/tone`'s tone
 * picker) — each needs its own `StateField` and its own effects, or two
 * pickers open in the same document would fight over one field and one
 * anchor. `selectionPlaced` is private to this module's own bookkeeping
 * (`pickerPreviewListener`); a concrete picker never dispatches it directly.
 */
export interface PickerCore {
  readonly open: StateEffectType<{ anchor: number }>;
  readonly close: StateEffectType<null>;
  readonly selectionPlaced: StateEffectType<null>;
  readonly field: StateField<PickerFieldState | null>;
}

export function createPickerCore(): PickerCore {
  const open = StateEffect.define<{ anchor: number }>();
  const close = StateEffect.define<null>();
  const selectionPlaced = StateEffect.define<null>();

  const field = StateField.define<PickerFieldState | null>({
    create: () => null,
    update(value, tr) {
      for (const effect of tr.effects) {
        if (effect.is(open)) return { anchor: effect.value.anchor, selectionPlaced: false };
        if (effect.is(close)) return null;
        if (effect.is(selectionPlaced) && value) return { ...value, selectionPlaced: true };
      }
      if (value && tr.docChanged) {
        return { ...value, anchor: tr.changes.mapPos(value.anchor) };
      }
      return value;
    },
  });

  return { open, close, selectionPlaced, field };
}

/** Opens the picker at the caret and starts the second completion step. */
export function openPicker(core: PickerCore, view: EditorView): void {
  const anchor = view.state.selection.main.head;
  view.dispatch({ effects: core.open.of({ anchor }) });
  startCompletion(view);
}

/**
 * The `selection` an option's `apply()` must pass alongside its `changes`,
 * even when the resulting position is exactly where the caret already sits.
 *
 * CM6 only treats a transaction as invalidating a completion source's
 * cached result when the transaction's `docChanged` or explicit `selection`
 * say so (see `ActiveSource`/`ActiveResult` in `@codemirror/autocomplete`).
 * The common case here is picking an option with **no filter text typed** —
 * `from === to`, so `{changes: {from, to, insert: ''}}` alone is a true
 * no-op transaction: no doc change, no selection given, nothing for CM6 to
 * react to. Left alone, the popup keeps showing the pre-commit option list
 * forever, because CM6 never re-queries a result it doesn't think is stale
 * — it looks like the commit silently did nothing, even though `apply()`'s
 * own side effect (the family/tone commit) already landed. An explicit
 * `selection`, even one that resolves to the same spot, forces CM6 to reset
 * every completion source unconditionally, which is what actually closes
 * (`/theme`) or clears the way for a fresh requery (`/tone`) — see each
 * file's own `apply()`.
 */
export function commitSelection(postChangePos: number): { anchor: number } {
  return { anchor: postChangePos };
}

/**
 * A picker's completion source is always synchronous — narrower than the
 * library's own `CompletionSource`, which also allows a `Promise`. Callers
 * (and their tests) get a plain `CompletionResult | null` back without an
 * `await` or a cast.
 */
export type PickerSource = (context: CompletionContext) => CompletionResult | null;

/**
 * Step-2 completion source: matches from the picker's anchor to the cursor,
 * whatever filter text the user has typed there. `buildOptions` is called
 * fresh on every query, which is intentional — for `/theme` it re-reads the
 * current on-screen tone each time (see `slash-theme.ts`).
 */
export function pickerSource(core: PickerCore, buildOptions: () => Completion[]): PickerSource {
  return (context: CompletionContext): CompletionResult | null => {
    const picker = context.state.field(core.field, false);
    if (!picker) return null;
    return { from: picker.anchor, options: buildOptions() };
  };
}

/**
 * Live preview (if `preview` is supplied) + initial-selection correction +
 * abort handling, while the picker is open.
 *
 * Initial selection: CM6 auto-selects its first sorted option the instant
 * the list becomes `active`. Left alone, a supplied `preview` would follow
 * that auto-selection and flash it for one frame on every open. So while
 * `picker.selectionPlaced` is `false`, `preview` is never called; instead,
 * the moment `completionStatus` first reports `'active'`, this dispatches
 * `setSelectedCompletion` at the option marked `'● current'` (the caller's
 * own marking, not recomputed here) plus `core.selectionPlaced`, in one
 * transaction — so the *next* update sees `selectionPlaced: true` and a
 * `selectedCompletion()` that already matches what's on screen or saved.
 * The `placing` flag guards against queuing that dispatch more than once
 * per opening.
 *
 * `/tone` reuses this same "wait for placement" machinery for more than the
 * initial open: applying a tone re-dispatches `core.open` in place (see
 * `slash-tone.ts`) to refresh the list — the `reopenedHere` check below is
 * what lets that happen without the code mistaking its own refresh for
 * either an auto-select flash or a user abort.
 *
 * Preview (once placed, and only if `preview` was supplied): follows
 * `selectedCompletion()` on every update. `/tone` passes no `preview` at
 * all, so this whole branch never runs for it — not "runs but does
 * nothing", never *called* — which is the guarantee its own tests check.
 *
 * Abort: the picker is still open but the popup just closed on its own
 * (Esc, blur, click elsewhere) — a commit closes the field itself in the
 * same transaction as its edit, so this only fires for the cases nothing
 * else already handled. `wasOpenBefore` excludes both the tick where
 * `openPicker` has dispatched but `startCompletion`'s own transaction
 * hasn't landed yet (without it, that tick reads as an instant abort before
 * the popup ever appears), and — via `reopenedHere` — any transaction that
 * carries `core.open` itself: a refresh forces every completion source back
 * to a momentary `null` status on purpose (see `slash-tone.ts`'s apply),
 * which would otherwise look identical to a real abort. The close dispatch
 * is deferred with `queueMicrotask` to avoid dispatching from inside an
 * update listener.
 */
export function pickerPreviewListener<TChoice>(
  core: PickerCore,
  completionType: string,
  choiceForLabel: (label: string) => TChoice | undefined,
  preview: ((choice: TChoice | null) => void) | undefined
): Extension {
  let placing = false;

  return EditorView.updateListener.of((update) => {
    const picker = update.state.field(core.field, false);
    if (!picker) {
      placing = false;
      return;
    }

    // True for the exact transaction that dispatched `core.open` — the
    // original open, or `/tone`'s in-place refresh after a commit. Either
    // way it means "(re)start waiting for placement", not "the popup that
    // was already up just closed on its own".
    const reopenedHere = update.transactions.some((tr) => tr.effects.some((e) => e.is(core.open)));

    if (!picker.selectionPlaced) {
      if (reopenedHere) placing = false;
      if (!placing && completionStatus(update.state) === 'active') {
        placing = true;
        const index = currentCompletions(update.state).findIndex((o) => o.detail === '● current');
        queueMicrotask(() => {
          update.view.dispatch({
            effects:
              index >= 0
                ? [setSelectedCompletion(index), core.selectionPlaced.of(null)]
                : [core.selectionPlaced.of(null)],
          });
        });
      }
      // No preview() until the correction above lands — see doc comment.
    } else if (preview) {
      const selected = selectedCompletion(update.state);
      preview(
        selected && selected.type === completionType
          ? (choiceForLabel(selected.label) ?? null)
          : null
      );
    }

    const wasOpenBefore = !reopenedHere && update.startState.field(core.field, false) !== null;
    if (wasOpenBefore && completionStatus(update.state) === null) {
      placing = false;
      const head = update.state.selection.main.head;
      queueMicrotask(() => {
        preview?.(null);
        update.view.dispatch({
          changes: { from: picker.anchor, to: head, insert: '' },
          effects: core.close.of(null),
        });
      });
    }
  });
}

/**
 * Bundles the field, the second completion source, and the preview listener.
 *
 * The languageData record is built ONCE, outside the arrow passed to
 * `.of()`, and captured by reference — not reconstructed inside it. CM6 calls
 * that arrow on every `languageDataAt` lookup (not once at setup) and detects
 * whether the active source set changed by comparing the returned providers'
 * *identity*. A fresh `{ autocomplete }` object (and a fresh `source`
 * closure) on every lookup reads as "the sources changed" on every single
 * query, forever, so `completionStatus` never left `pending` and the picker
 * never opened — measured in a real browser, not a jsdom artefact. See the
 * identical fix in `slash-commands.ts`.
 */
export function pickerExtensions<TChoice>(
  core: PickerCore,
  source: PickerSource,
  completionType: string,
  choiceForLabel: (label: string) => TChoice | undefined,
  preview: ((choice: TChoice | null) => void) | undefined
): Extension[] {
  const data = [{ autocomplete: source }];
  return [
    core.field,
    EditorState.languageData.of(() => data),
    pickerPreviewListener(core, completionType, choiceForLabel, preview),
  ];
}
