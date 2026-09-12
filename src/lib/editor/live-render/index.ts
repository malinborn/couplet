import type { Extension } from '@codemirror/state';
import { liveRenderAtomic } from './atomic';
import { blockFormatKeymap } from './block-format';
import { headingSpaceInput } from './heading-input';
import { inlineContinuation } from './inline-continuation';
import { selectionToolbar } from './selection-toolbar';
import { elementInspector } from './inspector';
import { codeBlockArrowExit } from '../code-block-exit';

/**
 * Everything the live-render flavour adds on top of the shared decoration
 * layer. This bundle is only ever installed while that flavour is active —
 * in live-preview none of it is present in the editor state at all, which is
 * how the existing mode is guaranteed to behave exactly as before.
 *
 * Order matters in one place: `liveRenderAtomic` must come first, because the
 * keymaps and the input handler below all assume the caret has already been
 * normalised out of hidden marker ranges.
 *
 * Both keymaps here carry their own precedence at the source, and the two are
 * deliberately different: `inlineContinuation()`'s Escape is `Prec.high`,
 * while `blockFormatKeymap`'s Backspace needs `Prec.highest` — verified
 * against a real keypress, `Prec.high` never reaches it, because Backspace is
 * resolved through the view's PendingKeys / beforeinput path rather than from
 * keydown alone. See the comment on `blockFormatKeymap`.
 */
export function liveRenderExtensions(options?: {
  /**
   * `range` is set only when the selection lives inside a widget's nested
   * editing host (table cell text), where `state.selection` cannot describe
   * it — see `selection-toolbar.ts` and `cell-anchor.ts`.
   */
  onComment?: (range?: { from: number; to: number }) => void;
}): Extension[] {
  return [
    ...liveRenderAtomic,
    blockFormatKeymap,
    // Arrow-key exit from a fenced code block. Only here, never in
    // live-preview, where the fence lines are visible under the caret and must
    // stay reachable — see the comment on `codeBlockArrowExit`. The Enter exit
    // itself is engine-wide and lives in `../setup.ts`.
    codeBlockArrowExit(),
    headingSpaceInput(),
    inlineContinuation(),
    selectionToolbar({ onComment: options?.onComment }),
    elementInspector(),
  ];
}

export { exitContinuationOnFormatToggle } from './inline-continuation';
export type { ExitableFormatKind } from './inline-continuation';
