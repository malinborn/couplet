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
import { markupModelField, type MarkupPair } from './atomic';
import { wellFormedMarkup } from './markup-repair';
import { isDelimiterRunPair } from './markup-whitespace';
import '../../../styles/live-render-caret.css';

/**
 * Live-render — **inline-format continuation** (#32, #66) and the data behind
 * the format-aware caret (#67).
 *
 * ## What the caret's offset already tells us, and what it cannot
 *
 * For `**bold**`, the position before the closing marker and the position
 * after it paint at the same pixel, because the markers are zero-width and
 * absent from the DOM. #32 measured that the two are nevertheless reached by
 * **different gestures**, on `Абзац с **жирным** словом.` (content 10..16,
 * closing marker 16..18):
 *
 * | how the caret gets there | offset | so typing goes |
 * |---|---|---|
 * | typing the last content character | 16 | inside |
 * | ArrowRight from inside the word | 16 | inside |
 * | clicking the space after the word | 18 | outside |
 * | ArrowRight once more, from 16 | 18 | outside |
 *
 * That measurement is still true and this module still honours it. Offset 16
 * means "I came from inside"; offset 18 means "I clicked next to it". Nothing
 * here redirects 18 back to 16 — the single most reported thing about this mode
 * was exactly that redirect, and it stays gone.
 *
 * ## Why continuation is nevertheless the default now (#66)
 *
 * #32 concluded from the table above that continuation should be *opt-in*. It
 * read the evidence right and drew one conclusion too many, because there was a
 * third thing happening at offset 16 that nobody had looked at: typing a
 * **space** there produced `**как **`, which CommonMark refuses to parse
 * (a closing delimiter run may not follow whitespace). Lezer dropped the
 * `StrongEmphasis`, the markers stopped being hidden, and four characters of
 * raw markup appeared mid-sentence — #66. So "typing at 16 continues the
 * format" was never actually true; it was true for letters and broken for the
 * one character that ends every word.
 *
 * With `markup-whitespace.ts` holding the invariant, the space is written
 * *outside* the span (`**как** `) and the document is well-formed at every
 * keystroke. What is left is the part a filter cannot know: the user has not
 * finished the bold phrase, they have only finished a word. That is what this
 * module now carries — a **pending format**, set when a space is deflected out
 * of a span, which makes the next character step back inside.
 *
 * So the two things coexist without either being weakened:
 *
 * - **The offset still decides**, and continuation-by-default lives entirely at
 *   offset 16. Typing there continues the format, for letters as before and now
 *   for spaces too.
 * - **A click still lands at 18 and still types plain text.** Pending format is
 *   only ever set by an action taken *from inside* the span — deflecting a
 *   space out of it — or by an explicit Cmd+B. A click sets nothing, so
 *   "click in the space after a bold word, type, get bold" remains fixed.
 *
 * ## Turning it off
 *
 * Two gestures, and **neither touches the document** — they only change editor
 * state, so no whitespace-sensitive markdown (a two-space hard line break, list
 * indentation) can be disturbed by ending a format:
 *
 * - **Escape** — the meaning this mode already documents, "leave the inline
 *   format span". At a pending boundary it clears the pending format; at the
 *   inner edge it steps the caret out to the far side of the closing marker.
 *   Where no inline format is active it returns `false` and falls through
 *   untouched, so clearing AI highlights and closing panels still work.
 * - **The matching format key** (Cmd+B for bold, Cmd+I for italic,
 *   Cmd+Shift+X for strikethrough) — the toggle reading of a toggle key: the
 *   format is on, the key turns it off. Pressed where that format is *not*
 *   active it is the ordinary toggle, unchanged, in both engines.
 *
 * A third one is implicit and is the one people actually use: move the caret
 * anywhere else and the pending format is gone, because it is validated against
 * the caret on every transaction rather than stored as a mode.
 *
 * Everything that decides *what happens* is a pure function of `EditorState`
 * (`planContinuationInsert`, `continuationEscapeSpec`, `continuationFormatKeySpec`,
 * `activeFormatsAt`, `pendingFormatAt`) so it is testable without a DOM — this
 * project's test env has no jsdom and no test constructs a real `EditorView`.
 * Only the thin wrappers at the bottom touch a view. Note the standing warning
 * in `CLAUDE.md` though: anything routed through a keymap or an `inputHandler`
 * cannot be proved by those tests. Drive the real app.
 */

export type ContinuableKind = 'strong' | 'emphasis' | 'strikethrough' | 'inlineCode';

/** The subset continuable via the existing Cmd+B / Cmd+I / Cmd+Shift+X bindings. */
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

const CONTINUABLE_PAIR_KINDS: ReadonlySet<string> = new Set(Object.keys(NODE_NAME));

function isContinuablePair(pair: MarkupPair): boolean {
  return CONTINUABLE_PAIR_KINDS.has(pair.kind);
}

export interface ContinuationBoundary {
  kind: ContinuableKind;
  node: SyntaxNode;
  /** Position right before the closing marker starts — where continued typing lands. */
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
 * ends there, not the `Emphasis` that begins there, so a key arms the span
 * that was just closed rather than reaching into one that hasn't started.
 */
export function findContinuationBoundary(state: EditorState, pos: number): ContinuationBoundary | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (node.to === pos) {
      const kind = KIND_BY_NODE_NAME.get(node.name);
      if (kind) {
        const marks = node.getChildren(MARK_NAME[kind]);
        const closeMark = marks[marks.length - 1];
        // A malformed/single-mark node means there is nothing to continue.
        if (closeMark && closeMark.to === node.to && closeMark.from > node.from) {
          return { kind, node, insertAt: closeMark.from };
        }
      }
    }
    node = node.parent;
  }
  return null;
}

/**
 * A format the next typed character should re-enter, even though the caret is
 * standing outside the span.
 *
 * `caret` is where the caret must be for this to apply and `spanEnd` is the
 * span's outer edge; the text between them is whatever was deflected out
 * (whitespace, or nothing at all when a Cmd+B armed the boundary directly).
 * Storing both is what lets the state be **re-validated** on every transaction
 * instead of trusted: if the caret moved, if the gap stopped being whitespace,
 * or if the span is no longer there, the pending format simply evaporates. That
 * is why "move away and come back" is not sticky — it is not a mode.
 */
export interface PendingFormat {
  caret: number;
  spanEnd: number;
  kind: ContinuableKind;
}

/** Effect carrying a pending format, or `null` to clear it. Values are in post-change coordinates. */
export const setPendingFormat = StateEffect.define<PendingFormat | null>();

function gapIsBlank(state: EditorState, from: number, to: number): boolean {
  if (to < from) return false;
  if (to === from) return true;
  return /^\s+$/.test(state.sliceDoc(from, to));
}

/**
 * Does `value` still describe the state it was recorded against? Everything
 * this field promises rests on this being re-checked rather than remembered.
 */
function stillPending(state: EditorState, value: PendingFormat): boolean {
  const sel = state.selection.main;
  if (!sel.empty || sel.head !== value.caret) return false;
  if (value.spanEnd > value.caret) return false;
  if (!gapIsBlank(state, value.spanEnd, value.caret)) return false;
  const boundary = findContinuationBoundary(state, value.spanEnd);
  return !!boundary && boundary.kind === value.kind;
}

/**
 * The one pending format, or `null`.
 *
 * Mapping happens **before** the effects are applied, which is the opposite of
 * how this field was written for #32 and is the only order that lets a single
 * transaction both change the document and set the state that describes the
 * result: an effect dispatched alongside changes carries post-change
 * coordinates, so mapping it again would move it twice.
 */
export const continuationField: StateField<PendingFormat | null> = StateField.define<PendingFormat | null>({
  create: () => null,
  update(value, tr) {
    if (value && tr.docChanged) {
      value = {
        caret: tr.changes.mapPos(value.caret, 1),
        spanEnd: tr.changes.mapPos(value.spanEnd, -1),
        kind: value.kind,
      };
    }
    for (const effect of tr.effects) {
      if (effect.is(setPendingFormat)) value = effect.value;
    }
    if (!value) return null;
    return stillPending(tr.state, value) ? value : null;
  },
});

export function pendingFormatAt(state: EditorState, pos: number): PendingFormat | null {
  const value = state.field(continuationField, false) ?? null;
  return value && value.caret === pos ? value : null;
}

/**
 * Whether the live-render bundle is installed in this state. The field above is
 * added only by that bundle, so its absence means the flavour is not active.
 * `keybindings.ts` is shared with live-preview and must be able to ask —
 * swallowing a key or picking a different command there would change the
 * existing mode's behaviour.
 */
export function isLiveRenderActive(state: EditorState): boolean {
  return state.field(continuationField, false) !== undefined;
}

/** Every continuable pair whose *content* covers `pos` — i.e. typing at `pos` produces these formats. */
function pairsCovering(state: EditorState, pos: number): MarkupPair[] {
  const { pairs } = state.field(markupModelField);
  return pairs.filter((p) => isContinuablePair(p) && p.contentFrom <= pos && pos <= p.contentTo);
}

/**
 * The outermost delimiter-run span whose content *ends* exactly at `pos` — the
 * "inner edge". Outermost, because whitespace deflected out of a nested span
 * has to clear every marker it is inside of: at the end of `*a **b***` the
 * position is the inner edge of both spans, and stopping at the inner one would
 * leave the space against the outer one's closing marker.
 *
 * Inline code is excluded on purpose: `` `как ` `` is a valid `InlineCode`
 * (measured), the space is content the user can see, and moving it would be a
 * bug rather than a repair. See `markup-whitespace.ts`.
 */
function spanAtInnerEdge(state: EditorState, pos: number): MarkupPair | null {
  const { pairs } = state.field(markupModelField);
  let best: MarkupPair | null = null;
  for (const pair of pairs) {
    if (!isDelimiterRunPair(pair) || pair.contentTo !== pos) continue;
    if (!best || pair.closeTo - pair.openFrom > best.closeTo - best.openFrom) best = pair;
  }
  return best;
}

function startsWithWhitespace(text: string): boolean {
  return text.length > 0 && /\s/.test(text[0]);
}

function isAllWhitespace(text: string): boolean {
  return text.length > 0 && /^\s+$/.test(text);
}

/**
 * The whole typing decision for one inserted string, as a pure function.
 * Returns the transaction to dispatch instead of the default insertion, or
 * `null` to let CM6 insert normally.
 *
 * Only the single-position case (`from === to`, a plain typed character) is
 * handled — a DOM change that already spans a range is a selection
 * replacement, not a continuation decision.
 *
 * Three outcomes, in the order they are tested:
 *
 * 1. **Absorb.** A pending format is live at this caret and the character can
 *    legally sit before a closing delimiter, so the closing marker moves past
 *    the deflected whitespace and the new character: `**как** ` + `д` becomes
 *    `**как д**`. This is the only place that rewrites a marker, and it is why
 *    the transaction is annotated `wellFormedMarkup` — see below.
 * 2. **Deflect.** No pending format, the caret is at a span's inner edge, and
 *    the character is whitespace, which cannot legally sit there. It is written
 *    on the far side of the closing marker (`**как**` + ` ` → `**как** `) and a
 *    pending format is recorded so the next character comes back in. Without
 *    this the document would hold `**как **` until the user typed again — #66.
 * 3. **Nothing.** Default insertion. Covers a letter typed at the inner edge
 *    (already inside, already correct, no help needed) and anything typed at
 *    the outer edge with nothing pending (a click landed there; plain text).
 *
 * Whitespace typed *at* a pending boundary also falls to (3): absorbing it
 * would recreate `**как **`. It inserts plainly and the pending format
 * survives, so `**как** ` + ` ` + `д` gives `**как  д**` — the two spaces the
 * user typed, inside the bold they never left.
 */
export function planContinuationInsert(
  state: EditorState,
  from: number,
  to: number,
  insert: string
): TransactionSpec | null {
  if (from !== to || !insert) return null;

  const pending = pendingFormatAt(state, from);
  if (pending) {
    if (startsWithWhitespace(insert)) return null;
    const boundary = findContinuationBoundary(state, pending.spanEnd);
    if (!boundary || boundary.kind !== pending.kind) return null;
    const closeFrom = boundary.insertAt;
    const closeText = state.sliceDoc(closeFrom, pending.spanEnd);
    return {
      changes: [
        { from: closeFrom, to: pending.spanEnd, insert: '' },
        { from, to: from, insert: insert + closeText },
      ],
      selection: EditorSelection.cursor(from - closeText.length + insert.length),
      effects: setPendingFormat.of(null),
      annotations: wellFormedMarkup.of(true),
      userEvent: 'input.type',
    };
  }

  if (!isAllWhitespace(insert)) return null;
  const span = spanAtInnerEdge(state, from);
  if (!span) return null;
  const caret = span.closeTo + insert.length;
  return {
    changes: { from: span.closeTo, to: span.closeTo, insert },
    selection: EditorSelection.cursor(caret),
    effects: setPendingFormat.of({ caret, spanEnd: span.closeTo, kind: span.kind as ContinuableKind }),
    userEvent: 'input.type',
  };
}

/**
 * Pure decision for `Escape`. Two jobs, and `null` for everything else so the
 * key keeps falling through to the AI-highlight and panel handlers exactly as
 * before — Escape must not grow a third meaning here.
 *
 * - at a pending boundary: end the format (state only, no edit);
 * - at a span's inner edge: leave the span, by moving the caret to the far side
 *   of the closing marker. Zero pixels of movement, two offsets of meaning —
 *   which is precisely the distinction the whole module is about.
 */
export function continuationEscapeSpec(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  if (pendingFormatAt(state, sel.head)) return { effects: setPendingFormat.of(null) };
  const span = spanAtInnerEdge(state, sel.head);
  if (span) return { selection: EditorSelection.cursor(span.closeTo) };
  return null;
}

/**
 * Pure decision for a Cmd+B-family key with an empty selection, *before* the
 * ordinary toggle gets a turn. A non-null return means "handled, dispatch this
 * and stop"; `null` means "not a continuation question" and `keybindings.ts`
 * proceeds exactly as it did.
 *
 * The kind must match the key — Cmd+B only answers for `'strong'` — so
 * pressing the "wrong" one at a boundary falls through to the normal toggle.
 * There is no key for `inlineCode`, so an inline-code span cannot be continued
 * this way; its content is literal text, where continuing is least useful.
 *
 * | caret | effect |
 * |---|---|
 * | pending format of this kind | end it |
 * | inner edge of a span of this kind | leave the span (caret to the outer edge) |
 * | outer edge of a span of this kind | start a pending format — the opt-in from #32 |
 * | anywhere else | `null`; ordinary toggle |
 *
 * The outer-edge row is also what stops the key from being destructive there:
 * letting the normal toggle run would resolve the enclosing node and **unwrap**
 * the span the user was trying to extend.
 */
export function continuationFormatKeySpec(
  state: EditorState,
  kind: ExitableFormatKind
): TransactionSpec | null {
  if (!isLiveRenderActive(state)) return null;
  const sel = state.selection.main;
  if (!sel.empty) return null;

  const pending = pendingFormatAt(state, sel.head);
  if (pending) return pending.kind === kind ? { effects: setPendingFormat.of(null) } : null;

  const inner = spanAtInnerEdge(state, sel.head);
  if (inner) return inner.kind === kind ? { selection: EditorSelection.cursor(inner.closeTo) } : null;

  const boundary = findContinuationBoundary(state, sel.head);
  if (!boundary || boundary.kind !== kind) return null;
  return {
    effects: setPendingFormat.of({ caret: sel.head, spanEnd: sel.head, kind }),
  };
}

/** View wrapper around `continuationFormatKeySpec` — see its contract above. */
export function armContinuationOnFormatToggle(view: EditorView, kind: ExitableFormatKind): boolean {
  const spec = continuationFormatKeySpec(view.state, kind);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

/**
 * **The formats the next typed character will carry** — the data behind #67's
 * format-aware caret, and the honest answer to "which format am I in", which
 * in this mode is otherwise invisible because the markers are hidden.
 *
 * Two cases, and they are the same two the rest of the module turns on:
 *
 * - a pending format is live → report what the span the character will rejoin
 *   contains, resolved at that span's content end rather than at the caret. So
 *   the caret is bold *before the first character appears*, which is the whole
 *   point of the feature.
 * - otherwise → every continuable span whose **content** covers the caret.
 *   `contentFrom <= pos <= contentTo` is deliberately inclusive at both ends
 *   and is exactly #32's offset rule: at offset 16 (inner edge, reached by
 *   typing or by an arrow) the span counts and the caret is bold; at offset 18
 *   (outer edge, reached by a click) it does not and the caret is plain. The
 *   caret therefore *paints* the gesture distinction that used to be
 *   unobservable.
 *
 * Returns every applicable format rather than a winner: `***x***` is bold *and*
 * italic, and a caret that showed only one of them would be telling the user
 * something false. Combining the cues is a CSS problem, solved in
 * `live-render-caret.css`.
 *
 * An empty selection only — a range selection has no single "next character",
 * and the toolbar is the affordance there.
 */
export function activeFormatsAt(state: EditorState): ContinuableKind[] {
  const sel = state.selection.main;
  if (!sel.empty) return [];

  const pending = pendingFormatAt(state, sel.head);
  if (pending) {
    const boundary = findContinuationBoundary(state, pending.spanEnd);
    if (!boundary) return [];
    return pairsCovering(state, boundary.insertAt).map((p) => p.kind as ContinuableKind);
  }
  return pairsCovering(state, sel.head).map((p) => p.kind as ContinuableKind);
}

/** Kept for the caret affordance's "the user chose this" hint — see the CSS. */
export function isContinuationActive(state: EditorState): ContinuableKind | null {
  const sel = state.selection.main;
  const pending = pendingFormatAt(state, sel.head);
  return pending ? pending.kind : null;
}

function continuationInputHandler(view: EditorView, from: number, to: number, insert: string): boolean {
  const spec = planContinuationInsert(view.state, from, to, insert);
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

/** Class on `view.dom` while a pending format is live — see `live-render-caret.css`. */
const CONTINUATION_ACTIVE_CLASS = 'cm-continuation-active';

/** One class per active format, for the caret shapes of #67. */
const FORMAT_CLASS: Record<ContinuableKind, string> = {
  strong: 'cm-fmt-strong',
  emphasis: 'cm-fmt-emphasis',
  strikethrough: 'cm-fmt-strikethrough',
  inlineCode: 'cm-fmt-code',
};

/**
 * Publishes the active formats as classes on the editor root (the same idiom as
 * the horizontal-scroll gutter fix in `setup.ts`), so the caret can carry them.
 *
 * The caret itself stays CM6's: `drawSelection()` owns its position, its
 * blinking and its `prefers-reduced-motion` handling, and this plugin never
 * touches the `.cm-cursor` element — it only changes what CSS matches. Styling
 * `caret-color` would do nothing, because `drawSelection()` ships
 * `.cm-line { caret-color: transparent !important }` app-wide and draws a div
 * instead (established in #45).
 */
const formatCaretPlugin = ViewPlugin.fromClass(
  class {
    constructor(private view: EditorView) {
      this.sync();
    }
    update(): void {
      this.sync();
    }
    destroy(): void {
      this.apply([], false);
    }
    private sync(): void {
      this.apply(activeFormatsAt(this.view.state), isContinuationActive(this.view.state) !== null);
    }
    private apply(formats: ContinuableKind[], pending: boolean): void {
      const { classList } = this.view.dom;
      for (const [kind, cls] of Object.entries(FORMAT_CLASS) as [ContinuableKind, string][]) {
        classList.toggle(cls, formats.includes(kind));
      }
      classList.toggle(CONTINUATION_ACTIVE_CLASS, pending);
    }
  }
);

/**
 * Bundles the input handler, the pending-format field, the caret plugin and the
 * `Escape` binding.
 *
 * The keymap is `Prec.high()` because the main keymap is registered in
 * `setup.ts` before `previewCompartment`, and equal-precedence handlers run in
 * registration order — without it `aiHighlightKeymap`'s own `Escape` would win
 * whenever both apply. `Prec.high` is enough here and `Prec.highest` is not
 * needed: Escape carries no `inputType`, so unlike Backspace it is resolved
 * from `keydown` alone. Do not "simplify" the two to match.
 */
export function inlineContinuation(): Extension {
  return [
    continuationField,
    EditorView.inputHandler.of(continuationInputHandler),
    formatCaretPlugin,
    Prec.high(keymap.of([{ key: 'Escape', run: exitContinuationOnEscape }])),
  ];
}
