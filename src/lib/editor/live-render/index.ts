import type { Extension } from '@codemirror/state';
import { liveRenderAtomic } from './atomic';
import { blockFormatKeymap } from './block-format';
import { markupRepairFilter } from './markup-repair';
import { markupDeleteKeymap } from './markup-delete';
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
    // Registered *after* `caretNormalizeFilter` (the last entry of
    // `liveRenderAtomic`) because CM6 applies transaction filters in reverse
    // facet order: the last one registered is the first one to run. So the edit
    // is repaired into well-formed markdown, and only then is the caret of the
    // repaired transaction normalised. The other order would normalise a caret
    // against a document that is about to change under it.
    markupRepairFilter,
    blockFormatKeymap,
    // `Prec.highest`, and after `blockFormatKeymap` so that stripping a block's
    // formatting at its start still wins — see `markupDeleteKeymap`.
    markupDeleteKeymap,
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

export { armContinuationOnFormatToggle } from './inline-continuation';
export type { ExitableFormatKind } from './inline-continuation';
