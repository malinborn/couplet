import { syntaxTree } from '@codemirror/language';
import {
  ChangeSet,
  EditorSelection,
  Prec,
  type ChangeSpec,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import { keymap, type Command, type EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { computeFenceAutoClose } from './autocomplete';

/**
 * Getting *out* of a fenced code block with the keyboard (#52).
 *
 * In live-render the fences are hidden by a zero-height line decoration, so a
 * code block has no visible edge: Enter only ever adds lines inside it and the
 * caret has nowhere to walk to. The exit gesture mirrors the one lists and
 * blockquotes already have in `autocomplete.ts` — an Enter on an *empty* last
 * item leaves the block, and the empty line you escaped through is not left
 * behind.
 *
 * ## The rule
 *
 * Enter exits only when all of these hold:
 *
 * - the caret sits on the **last content line** of a *terminated* fence;
 * - that line is blank;
 * - there is at least one content line above it.
 *
 * The third condition is what makes the gesture cost exactly two Enters rather
 * than one: the first Enter creates the blank line, the second one consumes it.
 * It also stops a freshly inserted (still empty) fence from ejecting the caret
 * on the very first Enter.
 *
 * ## Why "only at the end"
 *
 * Blank lines are ordinary code — people separate functions with a reflexive
 * double Enter. A two-Enter exit that fired anywhere in the block would make
 * that impossible with the plain key, which is more annoying than the bug it
 * fixes. Mid-block, Enter is therefore always just an Enter; only the end of
 * the block is an exit.
 *
 * That qualifier protects the reflex only when you are editing *into* code that
 * already exists. Measured by typing: writing top-down, the end of the block is
 * where you always are, so `const a = 1;` Enter Enter `const b = 2;` leaves the
 * block and drops the second line into a paragraph below it. The mitigations
 * are that it is immediately visible (no code background, no highlighting) and
 * that a single Cmd+Z puts the caret back on the blank line inside the block.
 * There is no Enter-count rule that avoids this: any "exit after N blank lines"
 * breaks whoever wanted N blank lines — with N = 2, that is PEP 8.
 *
 * The counterpart is a trailing blank line *inside* the code, and that is what
 * Shift+Enter is for. It is deliberately **not** bound here: CM6's
 * `standardKeymap` already maps it to `insertNewlineAndIndent` (`{key: "Enter",
 * run: insertNewlineAndIndent, shift: insertNewlineAndIndent}`), and a keymap
 * entry without a `shift` property — like the one below — is never consulted
 * for Shift+Enter. So Shift+Enter inserts, any number of times, at any position
 * including the end, for free. Binding it again would only create a second
 * place to keep in sync.
 *
 * ## Applies to every engine
 *
 * Registered in `setup.ts` outside `previewCompartment`, so raw, live-preview
 * and live-render all behave the same, exactly like list continuation does. The
 * *arrow* exit below is the one thing that is live-render only, for a reason
 * documented there.
 */

export interface CodeBlockExit {
  changes: ChangeSpec[];
  /** Caret position after `changes` is applied, already mapped through them. */
  caret: number;
}

export interface FenceGeometry {
  /** Line number of the opening ``` fence. */
  openLine: number;
  /** Line number of the closing ``` fence. */
  closeLine: number;
  /** First content line; greater than `lastContent` when the block is empty. */
  firstContent: number;
  /** Last content line, i.e. the one directly above the closing fence. */
  lastContent: number;
}

function enclosingFence(state: EditorState, pos: number): SyntaxNode | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(pos, side);
    while (node) {
      if (node.name === 'FencedCode') return node;
      node = node.parent;
    }
  }
  return null;
}

/**
 * Lines of the fenced code block enclosing `pos`, or null when there isn't one.
 *
 * Returns null for an *unterminated* fence as well. Lezer gives such a block a
 * single `CodeMark` child and runs it to the end of the document, so there is
 * no "after the block" to exit into — every line we could move to would still
 * be code. Closing the fence for the user is a different feature.
 *
 * The closing line is read from the last `CodeMark`, not from `node.to`, which
 * is the end of the last content line when the fence is unterminated.
 */
export function fenceGeometryAt(state: EditorState, pos: number): FenceGeometry | null {
  const node = enclosingFence(state, pos);
  if (!node) return null;

  const marks = node.getChildren('CodeMark');
  if (marks.length < 2) return null;

  const openLine = state.doc.lineAt(node.from).number;
  const closeLine = state.doc.lineAt(marks[marks.length - 1].from).number;
  if (closeLine <= openLine) return null;

  return { openLine, closeLine, firstContent: openLine + 1, lastContent: closeLine - 1 };
}

/**
 * Pure planning function for the Enter exit. Returns null whenever the default
 * Enter should run instead — which is every position but one.
 */
export function computeCodeBlockExit(state: EditorState): CodeBlockExit | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;

  const geo = fenceGeometryAt(state, sel.head);
  if (!geo) return null;

  const doc = state.doc;
  const line = doc.lineAt(sel.head);
  // Mid-block Enter is always just an Enter, so a blank line between two
  // functions stays writable with the plain key.
  if (line.number !== geo.lastContent) return null;
  // Needs a content line above: the first of the two Enters made this one.
  if (line.number <= geo.firstContent) return null;
  if (line.text.trim() !== '') return null;

  // Remove the blank line together with the newline that introduced it, so the
  // line the user escaped through leaves no trace. Only this one line — a
  // trailing blank the user authored with Shift+Enter sits above it and stays.
  const changes: ChangeSpec[] = [{ from: line.from - 1, to: line.to }];

  const closeLine = doc.line(geo.closeLine);
  const after = geo.closeLine < doc.lines ? doc.line(geo.closeLine + 1) : null;

  let caretSource: number;
  if (after && after.text.trim() === '') {
    // Already an empty line below the block — land on it rather than adding a
    // second one.
    caretSource = after.from;
  } else {
    // Either the block ends the file, or real content follows it. Both want a
    // fresh empty line to type into; assoc 1 puts the caret after the newline.
    changes.push({ from: closeLine.to, insert: '\n' });
    caretSource = closeLine.to;
  }

  return { changes, caret: ChangeSet.of(changes, doc.length).mapPos(caretSource, 1) };
}

/** The command bound to Enter. Returns false everywhere the exit does not apply. */
export const exitCodeBlockOnEnter: Command = (view) => {
  const result = computeCodeBlockExit(view.state);
  if (!result) return false;

  view.dispatch({
    changes: result.changes,
    selection: EditorSelection.cursor(result.caret),
    userEvent: 'input',
    scrollIntoView: true,
  });
  return true;
};

/**
 * Enter inside a fenced code block that sits in a blockquote keeps the new
 * line in the quote.
 *
 * Nothing else does: `@codemirror/lang-markdown`'s continuation bails out
 * wherever the fence's own language is active (`isActiveAt`), and the plain
 * newline it falls back to has no `> `. That line ends the quote, which closes
 * the fence early and turns the rest of the block into a new, unterminated
 * one — invisible as a cause once the quote and the fences are rendered.
 *
 * The prefix is the current line's own, exactly one level per enclosing quote
 * (a deeper `>` is the code's text), plus the code's indentation. With the
 * caret at or before the end of the prefix, a prefixed line is opened above
 * instead. Returns null on the closing fence line and at the end of the opening
 * one (the fence auto-close owns that), so the default Enter keeps those.
 *
 * The two-Enter exit above does not fire inside a quote: a blank quoted line is
 * `> `, not blank. ArrowDown still leaves the block.
 */
export function computeQuotedCodeNewline(state: EditorState): CodeBlockExit | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const node = enclosingFence(state, sel.head);
  if (!node) return null;

  let depth = 0;
  for (let p: SyntaxNode | null = node.parent; p; p = p.parent) {
    if (p.name === 'Blockquote') depth++;
  }
  if (depth === 0) return null;

  const doc = state.doc;
  const line = doc.lineAt(sel.head);

  const level = /^[ \t]*>[ \t]?/;
  let prefixLength = 0;
  for (let i = 0; i < depth; i++) {
    const m = level.exec(line.text.slice(prefixLength));
    if (!m) break;
    prefixLength += m[0].length;
  }
  if (prefixLength === 0) return null;
  const head = sel.head;

  // At or inside the prefix — the line start is a legal caret stop in
  // live-render (Home, ArrowLeft over the hidden `> `). A bare newline there
  // leaves a line without `>`, which ends the quote and the fence with it, so
  // open a prefixed line above instead and keep the caret where it was.
  if (head <= line.from + prefixLength) {
    const insert = `${line.text.slice(0, prefixLength).trimEnd()}\n`;
    return { changes: [{ from: line.from, insert }], caret: head + insert.length };
  }

  const opening = line.number === doc.lineAt(node.from).number;
  // The end of the opening fence line belongs to the fence auto-close
  // (`autocomplete.ts`), which knows about the quote prefix too.
  if (opening && computeFenceAutoClose(line.text, head - line.from)) return null;
  const marks = node.getChildren('CodeMark');
  if (marks.length >= 2 && line.number >= doc.lineAt(marks[marks.length - 1].from).number) {
    return null;
  }

  let prefix = line.text.slice(0, prefixLength);
  if (!/[ \t]$/.test(prefix)) prefix += ' ';
  // The code's indentation carries over; the fence line's does not.
  const indent = opening ? '' : /^[ \t]*/.exec(line.text.slice(prefixLength))![0];
  const insert = `\n${prefix}${indent}`;
  return {
    changes: [{ from: sel.head, insert }],
    caret: sel.head + insert.length,
  };
}

/** Enter in a quoted code block — see `computeQuotedCodeNewline`. */
export const continueQuotedCode: Command = (view) => {
  const result = computeQuotedCodeNewline(view.state);
  if (!result) return false;
  view.dispatch({
    changes: result.changes,
    selection: EditorSelection.cursor(result.caret),
    userEvent: 'input',
    scrollIntoView: true,
  });
  return true;
};

/**
 * `Prec.highest`, not `Prec.high` — the same rule `blockFormatKeymap` carries
 * for Backspace. Enter is in the view's `PendingKeys` table twice
 * (`insertParagraph`, `insertLineBreak`), so where that path is live the key is
 * not resolved from `keydown` alone: the native edit lands and is reconciled
 * afterwards, and a binding that loses its turn does not fall through cleanly —
 * the DOM-derived change is applied instead.
 *
 * Measured honestly: driving real key presses in desktop Chrome, `Prec.high`
 * and `Prec.highest` behave identically here, because the `PendingKeys` branch
 * in `@codemirror/view` is gated on `browser.ios`
 * (`safari && (/Mobile\/\w+/ || maxTouchPoints > 2)`) or Chrome-on-Android, and
 * neither holds there. The app ships on macOS WKWebView, which *is* Safari —
 * one touch-capable input away from that gate opening — and the failure mode is
 * silent corruption rather than a dead key. The stronger precedence costs
 * nothing, so it is not worth being clever about.
 */
export const codeBlockExitKeymap: Extension = Prec.highest(
  keymap.of([
    { key: 'Enter', run: exitCodeBlockOnEnter },
    { key: 'Enter', run: continueQuotedCode },
  ])
);

// ---------------------------------------------------------------------------
// Arrow exit — live-render only
// ---------------------------------------------------------------------------

/**
 * What ArrowDown/ArrowUp should do when the caret is about to walk into a
 * hidden fence line:
 *
 * - `'pass'` — not our case, let the key do its normal thing;
 * - `'blocked'` — our case, but the block touches the edge of the document, so
 *   there is nothing beyond it to move to;
 * - a number — move the caret there. Column is preserved, clamped to the target
 *   line, so it still reads as a vertical move rather than a jump to column 0.
 */
export type FenceArrowTarget = number | 'pass' | 'blocked';

export function computeFenceArrowTarget(state: EditorState, down: boolean): FenceArrowTarget {
  const sel = state.selection.main;
  if (!sel.empty) return 'pass';

  const geo = fenceGeometryAt(state, sel.head);
  if (!geo) return 'pass';

  const doc = state.doc;
  const line = doc.lineAt(sel.head);
  if (line.number !== (down ? geo.lastContent : geo.firstContent)) return 'pass';

  const column = sel.head - line.from;

  if (down) {
    if (geo.closeLine >= doc.lines) return 'blocked';
    const target = doc.line(geo.closeLine + 1);
    return Math.min(target.from + column, target.to);
  }

  if (geo.openLine <= 1) return 'blocked';
  const target = doc.line(geo.openLine - 1);
  return Math.min(target.from + column, target.to);
}

function fenceArrow(down: boolean): Command {
  return (view: EditorView) => {
    const target = computeFenceArrowTarget(view.state, down);
    if (target === 'pass') return false;

    // `EditorView.lineWrapping` is on, so a long code line occupies several
    // visual rows and an arrow press inside one must stay inside it. Ask CM6
    // where its own vertical motion would land: if that is still this document
    // line, we are mid-wrap and have no business intercepting.
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    const natural = view.moveVertically(sel, down);
    if (view.state.doc.lineAt(natural.head).number === line.number) return false;

    // Swallow the key at the edge of the document rather than let the default
    // motion park the caret on the fence line, which is zero-height — the caret
    // would vanish with no way to tell it is still there.
    if (target === 'blocked') return true;

    view.dispatch({ selection: EditorSelection.cursor(target), scrollIntoView: true });
    return true;
  };
}

/**
 * The secondary escape hatch, and **live-render only** — this is a deliberate
 * divergence from live-preview.
 *
 * Under live-render the fence lines are permanently hidden, so the default
 * motion drops the caret onto a zero-height line where it is invisible; one
 * press appears to do nothing and the second one finally leaves. Skipping the
 * fence line makes ArrowDown/ArrowUp a real, non-mutating way out, which the
 * Enter gesture is not — Enter changes the document.
 *
 * In live-preview the fences are *revealed* whenever the caret is inside the
 * block (`flavour.ts` gives `fencedCode` policy `'on-cursor'` there), so those
 * lines are plain visible text. Skipping them would make the ``` line — and the
 * language on it — unreachable by keyboard, breaking editing that works today.
 *
 * Escape was considered and rejected: in this mode it already means "leave the
 * inline format span" (`inline-continuation.ts`), and elsewhere in the editor it
 * clears AI highlights and closes panels. A third, block-level meaning would
 * make the key unpredictable, and it would be the only exit that is invisible
 * in the UI. Arrows are what a person already tries first.
 */
export function codeBlockArrowExit(): Extension {
  return Prec.high(
    keymap.of([
      { key: 'ArrowDown', run: fenceArrow(true) },
      { key: 'ArrowUp', run: fenceArrow(false) },
    ])
  );
}
