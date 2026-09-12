import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import '../../../styles/live-render-caret.css';

/**
 * Live-render, Phase 5 — inline-format continuation.
 *
 * Under the `'never'` reveal policy (Phase 1) markdown markers stay hidden
 * permanently, and Phase 2's `caretNormalizeFilter` collapses every caret
 * position inside a hidden marker onto the single canonical position
 * *outside* it (`resolveInner`'s outer edge). That is correct for caret
 * placement, but it means the closing `**` of `**bold**` and the character
 * right after it now paint at the same screen pixel — there is no visual
 * difference between "about to type inside the bold" and "about to type
 * after it".
 *
 * This module resolves the ambiguity by policy: typing at that boundary lands
 * **outside** the span, because that is where the caret is and because the
 * offsets already distinguish the two cases (see `continuationRedirect` for the
 * measurement). Continuing the format is the explicit act — a Cmd+B-family
 * toggle with an empty selection at the boundary arms it
 * (`continuationFormatArmSpec`), `Escape` disarms it, and the caret carries a
 * visible hint while it is armed. The arrow keys are neither: an arrow press at
 * this boundary moves the caret two document offsets without moving it one
 * screen pixel (the marker is zero-width), which reads as a dead key.
 *
 * Everything that decides *whether* to redirect is a pure function of
 * `EditorState` (`findContinuationBoundary`, `continuationRedirect`,
 * `continuationEscapeSpec`, `continuationFormatArmSpec`,
 * `isContinuationActive`) so it is testable without a DOM — this project's
 * test env has no jsdom and no test constructs a real `EditorView`. Only
 * the thin wrappers at the bottom (`continuationInputHandler`, the caret
 * `ViewPlugin`, `exitContinuationOnEscape`) touch a view.
 */

export type ContinuableKind = 'strong' | 'emphasis' | 'strikethrough' | 'inlineCode';

/** The subset continuable via the existing Cmd+B / Cmd+I / Cmd+Shift+X bindings — see `continuationFormatArmSpec`. */
export type ExitableFormatKind = 'strong' | 'emphasis' | 'strikethrough';

const NODE_NAME: Record<ContinuableKind, string> = {
  strong: 'StrongEmphasis',
  emphasis: 'Emphasis',
  strikethrough: 'Strikethrough',
  inlineCode: 'InlineCode',
};

// Lezer tags both Emphasis and StrongEmphasis markers as `EmphasisMark` (the
// difference is marker length: `*`/`_` vs `**`/`__`) — same fact relied on
// by preview/inline.ts and live-render/format-commands.ts.
const MARK_NAME: Record<ContinuableKind, string> = {
  strong: 'EmphasisMark',
  emphasis: 'EmphasisMark',
  strikethrough: 'StrikethroughMark',
  inlineCode: 'CodeMark',
};

const KIND_BY_NODE_NAME: ReadonlyMap<string, ContinuableKind> = new Map(
  (Object.entries(NODE_NAME) as [ContinuableKind, string][]).map(([kind, name]) => [name, kind])
);

export interface ContinuationBoundary {
  kind: ContinuableKind;
  node: SyntaxNode;
  /** Position right before the closing marker starts — where continued typing should land. */
  insertAt: number;
}

/**
 * Is `pos` the canonical (outer) position immediately after the closing
 * marker of a `StrongEmphasis` / `Emphasis` / `Strikethrough` / `InlineCode`
 * node? Returns the innermost such node, walking up from
 * `resolveInner(pos, -1)` — the `-1` bias is what makes this resolve to the
 * node *ending* at `pos` rather than one starting there.
 *
 * That bias also decides the adjacent-spans case (`**a**_b_`, boundary at
 * the position between them): it resolves to the `StrongEmphasis` that
 * ends there, not the `Emphasis` that begins there, so typing continues the
 * span that was just closed rather than reaching into the one that hasn't
 * started yet. Reaching into an unopened node has no natural meaning here —
 * "continuation" is inherently about the format you just finished, not one
 * you're about to start — so favoring the left side is the only reading
 * that makes sense, independent of which format happens to be which.
 */
export function findContinuationBoundary(state: EditorState, pos: number): ContinuationBoundary | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (node.to === pos) {
      const kind = KIND_BY_NODE_NAME.get(node.name);
      if (kind) {
        const marks = node.getChildren(MARK_NAME[kind]);
        const closeMark = marks[marks.length - 1];
        // Guard against a malformed/single-mark node (shouldn't happen for
        // a well-formed StrongEmphasis/Emphasis/Strikethrough/InlineCode,
        // but a missing closing mark means there's nothing to continue).
        if (closeMark && closeMark.to === node.to && closeMark.from > node.from) {
          return { kind, node, insertAt: closeMark.from };
        }
      }
    }
    node = node.parent;
  }
  return null;
}

/** Effect carrying the boundary position where continuation is explicitly armed, or `null` to clear it. */
export const setArmedBoundary = StateEffect.define<number | null>();

/**
 * The one boundary position (if any) where the user has explicitly asked for
 * the next character to **join** the span that ends there — via a Cmd+B-family
 * toggle. `null`, the default, means the next character lands where the caret
 * actually is, i.e. outside.
 *
 * This used to be the mirror image — a *suppressed* boundary, with continuation
 * on by default. See `continuationRedirect` for why that default was wrong and
 * why inverting it costs nothing in the flows that matter.
 *
 * Cleared automatically the moment the selection ends up anywhere other
 * than this exact position with an empty selection — "moves away and comes
 * back" is not sticky; arming is a one-shot, not a mode. Mapped through
 * document changes (bias -1, matching the boundary's own "outer edge"
 * convention) so an edit earlier in the document doesn't desync it from the
 * position it actually refers to.
 */
export const armedBoundaryField: StateField<number | null> = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setArmedBoundary)) {
        value = effect.value;
      }
    }
    if (value === null) return null;
    const mapped = tr.changes.mapPos(value, -1);
    const sel = tr.state.selection.main;
    if (!sel.empty || sel.head !== mapped) return null;
    return mapped;
  },
});

function isArmedAt(state: EditorState, pos: number): boolean {
  return state.field(armedBoundaryField, false) === pos;
}

/**
 * Pure decision for one typed insertion: redirect it to just before the
 * closing marker (continuing the format), or return `null` to let the
 * caller fall back to default insertion at `[from, to)`.
 *
 * Only handles the simple, single-position case (`from === to`, a plain
 * typed character) — a DOM change that already spans a range is a
 * selection replacement, not a continuation decision, so it's left alone.
 *
 * ### Why this needs arming, and why it used to not
 *
 * Continuation used to be the default and `Escape` the way out. That reads
 * well until you look at *which offsets the caret actually reaches*, which is
 * the thing the two-offsets-one-pixel note in `CLAUDE.md` is about:
 *
 * - Typing inside a span and reaching its end leaves the caret at the content's
 *   end (16 for `Абзац с **жирным**`), because the inserted character's mapped
 *   position is a boundary, not a strict interior, and the caret filter leaves
 *   boundaries alone. Typing continues inside with no help from this module.
 * - Walking right with the arrow keys stops at 16 for the same reason —
 *   `skipAtomicRanges` only moves a caret that is *strictly* inside a marker.
 * - A **click** at that pixel resolves to 18, outside, because the atomic skip
 *   breaks the tie toward `to`.
 *
 * So the offset already carries the intent: 16 means "I came from inside", 18
 * means "I clicked next to it". Redirecting 18 back to 16 threw that away, and
 * every measured complaint was the same one — click in the space after a bold
 * word, type, get bold. Defaulting to "insert where the caret is" costs nothing
 * (the inside-typing flow never goes through here) and fixes all of them.
 *
 * What is left for this function is the case the offsets genuinely cannot
 * express: the caret is legitimately outside, and the user wants back in
 * anyway. That is what the Cmd+B family arms — see `continuationFormatArmSpec`.
 */
export function continuationRedirect(
  state: EditorState,
  from: number,
  to: number,
  insert: string
): TransactionSpec | null {
  if (from !== to || !insert) return null;
  const boundary = findContinuationBoundary(state, from);
  if (!boundary) return null;
  if (!isArmedAt(state, from)) return null;

  return {
    changes: { from: boundary.insertAt, to: boundary.insertAt, insert },
    selection: EditorSelection.cursor(boundary.insertAt + insert.length),
    userEvent: 'input.type',
  };
}

/**
 * Pure decision for `Escape`: disarm continuation, or `null` if it is not
 * armed. Escape stays the way out, so the gesture the mode already documents
 * keeps working — it simply has something to undo now instead of something to
 * prevent.
 */
export function continuationEscapeSpec(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  if (!isArmedAt(state, sel.head)) return null;
  return { effects: setArmedBoundary.of(null) };
}

/**
 * Whether the live-render bundle is installed in this state. The field below
 * is added only by that bundle, so its absence means the flavour is not
 * active. `keybindings.ts` is shared with live-preview and must be able to ask
 * — swallowing a key or picking a different command there would change the
 * existing mode's behaviour.
 */
export function isLiveRenderActive(state: EditorState): boolean {
  return state.field(armedBoundaryField, false) !== undefined;
}

/**
 * Pure decision for a Cmd+B-family toggle with an empty selection sitting
 * exactly at `kind`'s span boundary: **arm** continuation, so the next typed
 * character joins that span, instead of letting the normal toggle run.
 *
 * This is the affordance that makes "insert outside by default" complete.
 * Clicking right after a bold word and wanting to extend it is a real need, and
 * the click cannot express it — the caret has only one offset to land on there.
 * Cmd+B at that spot now says "keep going in bold", which is both what the key
 * means everywhere else and non-destructive, whereas letting the toggle run
 * would resolve the enclosing node and **unwrap** the span the user was trying
 * to extend.
 *
 * Contract for `keybindings.ts`: call this *before* the normal toggle for the
 * matching marker. A non-null return means "handled, dispatch this and stop".
 * A `null` return means "not at a boundary of this kind" — proceed exactly as
 * before.
 *
 * The kind must match the key: Cmd+B only arms a `'strong'` boundary, Cmd+I
 * only `'emphasis'`, Cmd+Shift+X only `'strikethrough'`. Pressing the "wrong"
 * one at a boundary falls through to the normal toggle. There is no
 * Cmd+B-family key for `inlineCode`, so an inline-code span cannot be continued
 * this way — its content is literal text, where continuing is least useful.
 */
export function continuationFormatArmSpec(
  state: EditorState,
  kind: ExitableFormatKind
): TransactionSpec | null {
  if (!isLiveRenderActive(state)) return null;
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const boundary = findContinuationBoundary(state, sel.head);
  if (!boundary || boundary.kind !== kind) return null;
  // Pressing the key a second time at the same spot means "no, actually not" —
  // the toggle reads as a toggle rather than as a one-way latch.
  if (isArmedAt(state, sel.head)) return { effects: setArmedBoundary.of(null) };
  return { effects: setArmedBoundary.of(sel.head) };
}

/** View wrapper around `continuationFormatArmSpec` — see its contract above. */
export function armContinuationOnFormatToggle(view: EditorView, kind: ExitableFormatKind): boolean {
  const spec = continuationFormatArmSpec(view.state, kind);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

/**
 * Whether the caret is currently in a continuing position: an empty selection
 * sitting at an **armed** span boundary. Drives the caret affordance below —
 * which now means something the user can act on, "the next character will be
 * bold", rather than reporting a default they never chose. Exported for testing
 * that logic without touching the DOM-dependent `ViewPlugin`.
 */
export function isContinuationActive(state: EditorState): ContinuableKind | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const boundary = findContinuationBoundary(state, sel.head);
  if (!boundary) return null;
  if (!isArmedAt(state, sel.head)) return null;
  return boundary.kind;
}

function continuationInputHandler(view: EditorView, from: number, to: number, insert: string): boolean {
  const spec = continuationRedirect(view.state, from, to, insert);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

function exitContinuationOnEscape(view: EditorView): boolean {
  const spec = continuationEscapeSpec(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

/** CSS class toggled on `view.dom` while `isContinuationActive` holds — see `live-render-caret.css`. */
const CONTINUATION_ACTIVE_CLASS = 'cm-continuation-active';

/**
 * The only way the user can otherwise tell whether the next character will
 * join the format is to try it and see. This plugin toggles a class on the
 * editor root (same idiom as the horizontal-scroll gutter fix in
 * `setup.ts`) so the caret itself can carry the hint — see
 * `live-render-caret.css` for the subtle styling.
 */
const continuationCaretPlugin = ViewPlugin.fromClass(
  class {
    constructor(private view: EditorView) {
      this.sync();
    }
    update(): void {
      this.sync();
    }
    destroy(): void {
      this.view.dom.classList.remove(CONTINUATION_ACTIVE_CLASS);
    }
    private sync(): void {
      const active = isContinuationActive(this.view.state) !== null;
      this.view.dom.classList.toggle(CONTINUATION_ACTIVE_CLASS, active);
    }
  }
);

/**
 * Bundles the input handler, the suppression field, and the `Escape`
 * binding. The keymap is wrapped in `Prec.high()` because the main keymap
 * is registered in `setup.ts` (`:50-56`) before `previewCompartment`
 * (`:62`), and equal-precedence handlers run in registration order — without
 * `Prec.high()` here, `aiHighlightKeymap`'s own `Escape` binding (registered
 * earlier in `setup.ts`, but at default precedence) would still lose to
 * ours whenever both apply, since default keymaps have no built-in
 * ordering guarantee against a keymap added later in the same extension
 * array. `aiHighlightKeymap`'s command already returns `false` when there
 * is nothing for it to clear, so the common case (no AI highlights active)
 * is unaffected either way — see report for the one case where the two
 * *do* overlap.
 */
export function inlineContinuation(): Extension {
  return [
    armedBoundaryField,
    EditorView.inputHandler.of(continuationInputHandler),
    continuationCaretPlugin,
    Prec.high(keymap.of([{ key: 'Escape', run: exitContinuationOnEscape }])),
  ];
}
