import { keymap } from '@codemirror/view';
import { EditorSelection, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  armContinuationOnFormatToggle,
  isLiveRenderActive,
  type ExitableFormatKind,
} from './live-render/inline-continuation';
import { toggleInlineFormat } from './live-render/format-commands';

function toggleWrap(view: EditorView, marker: string): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const len = marker.length;

    // Check if already wrapped
    if (text.startsWith(marker) && text.endsWith(marker) && text.length >= len * 2) {
      return {
        changes: [{ from: range.from, to: range.to, insert: text.slice(len, -len) }],
        range: EditorSelection.range(range.from, range.to - len * 2),
      };
    }

    // Check surrounding context
    const before = state.sliceDoc(Math.max(0, range.from - len), range.from);
    const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + len));

    if (before === marker && after === marker) {
      return {
        changes: [
          { from: range.from - len, to: range.from, insert: '' },
          { from: range.to, to: range.to + len, insert: '' },
        ],
        range: EditorSelection.range(range.from - len, range.to - len),
      };
    }

    // Add markers
    return {
      changes: [{ from: range.from, to: range.to, insert: `${marker}${text}${marker}` }],
      range: EditorSelection.range(range.from + len, range.to + len),
    };
  });

  view.dispatch(changes);
  return true;
}

/**
 * Three behaviours share these keys.
 *
 * First, in live-render, sitting at the boundary of a hidden span means the
 * next keystroke lands *outside* it, and these keys are how the user says
 * "actually, keep going in this format" — the arrow keys deliberately are not,
 * since at that boundary they move the caret without moving it on screen. This
 * also protects the span: letting the toggle run there would resolve the
 * enclosing node and unwrap the very formatting the user was extending.
 *
 * Second, in live-render the keys apply formatting through the same
 * tree-aware command the selection toolbar uses, so the two cannot disagree.
 * `toggleWrap` below is a text heuristic: with `hello` selected inside
 * `**hello**` it sees one asterisk on each side, reads that as "already
 * wrapped", and strips one from each — turning bold into italic instead of
 * adding italic to it. The reverse order does not trigger the same test, which
 * is why bold-then-italic and italic-then-bold disagreed.
 *
 * Third, in every other flavour `toggleWrap` runs exactly as before.
 */
function toggleOrExit(view: EditorView, marker: string, kind: ExitableFormatKind): boolean {
  if (armContinuationOnFormatToggle(view, kind)) return true;
  if (isLiveRenderActive(view.state)) return toggleInlineFormat(view, kind);
  return toggleWrap(view, marker);
}

/** One inline-format key: which format it toggles, and the marker it writes. */
export interface InlineFormatBinding {
  kind: ExitableFormatKind;
  /** CM6 key spec — see `hotkey-label.ts` for turning it into a caption. */
  key: string;
  marker: string;
}

/**
 * The inline-format keys, as data rather than as three literals inside the
 * `keymap` call.
 *
 * Two consumers read this: the keymap right below, and the selection toolbar,
 * which shows the hotkey in a tooltip when the pointer rests on a button (#56).
 * The toolbar deliberately has no key table of its own — one that had to be
 * kept in step by hand would be wrong the first time a binding moved, and
 * wrong silently, since nothing checks a tooltip against a keymap.
 */
export const INLINE_FORMAT_BINDINGS: readonly InlineFormatBinding[] = [
  { kind: 'strong', key: 'Mod-b', marker: '**' },
  { kind: 'emphasis', key: 'Mod-i', marker: '*' },
  { kind: 'strikethrough', key: 'Mod-Shift-x', marker: '~~' },
];

export function markdownKeybindings(): Extension {
  return keymap.of(
    INLINE_FORMAT_BINDINGS.map(({ kind, key, marker }) => ({
      key,
      run: (view: EditorView) => toggleOrExit(view, marker, kind),
    }))
  );
}
