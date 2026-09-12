import { EditorSelection } from '@codemirror/state';
import { previewCompartment } from '@app/lib/editor/setup';
import { livePreviewPlugin } from '@app/lib/editor/preview/plugin';
import { LIVE_RENDER, flavourFacet } from '@app/lib/editor/preview/flavour';
import { liveRenderExtensions } from '@app/lib/editor/live-render';
import { mountDemoEditor } from './editor-demo';

/**
 * The live-render block — the one demo on this page a visitor can actually
 * type into.
 *
 * Every other card narrates something an agent does, so a scripted playback
 * tells the truth about it. This one is a claim about the visitor's own
 * keystrokes: the asterisks disappear the moment the span closes, the caret
 * changes shape to say which format the next character carries, and Backspace
 * through a marker repairs the markup instead of tearing it. None of that can
 * be demonstrated by playing a recording at someone — the interesting part is
 * that it answers *their* typing. So this mounts a real editor, editable, in
 * the same live-render configuration `App.svelte` installs in the app.
 *
 * It is deliberately not focused on mount: taking focus would scroll the page
 * to this card for anyone who merely passed it on the way to Features.
 */

/**
 * Short on purpose — it has to fit the card without scrolling, so a visitor's
 * first keystroke happens in view rather than below the fold. One of each
 * inline format, because the caret's shape is per-format and the point is to
 * let someone walk the caret across them and watch it change.
 */
const DOC = `## Ship it

The rollout is **gradual**, never *instant*, and ~~definitely~~ absolutely not
something we push on a Friday. Watch \`metrics.dashboard\` for the first hour.

- [x] Tag the build
- [ ] Draft the notes

Your turn — type on the line below. \`⌘B\` for bold, or just type the asterisks.
`;

interface Mounted {
  reset: () => void;
}

let mounted: Mounted | null = null;

export function mount(container: HTMLElement): void {
  const { view } = mountDemoEditor(container, { doc: DOC, editable: true });

  // Same shape as `applyPreviewConfig()` in App.svelte's live-render branch:
  // one plugin, the flavour facet that stops markers being revealed under the
  // caret, and the editing bundle on top. `onComment` is left out — there is
  // no sidecar to write on a marketing page, and the toolbar drops its 💬
  // button when nothing is listening rather than offering a dead one.
  view.dispatch({
    effects: previewCompartment.reconfigure([
      livePreviewPlugin,
      flavourFacet.of(LIVE_RENDER),
      ...liveRenderExtensions(),
    ]),
  });

  const card = container.closest<HTMLElement>('.demo');
  const hint = card?.querySelector<HTMLElement>('[data-lr-hint]') ?? null;
  const resetBtn = card?.querySelector<HTMLButtonElement>('[data-lr-reset]') ?? null;

  // The hint is signposting, and signposting that outstays the moment it
  // explains becomes clutter: it goes on the first keystroke, not on a timer.
  const dismissHint = (): void => {
    hint?.classList.add('is-dismissed');
  };
  view.dom.addEventListener('focusin', dismissHint, { once: true });

  function reset(): void {
    const doc = DOC.endsWith('\n\n') ? DOC : `${DOC}\n`;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc },
      selection: EditorSelection.cursor(doc.length),
    });
  }

  if (resetBtn) {
    resetBtn.hidden = false;
    resetBtn.addEventListener('click', () => {
      reset();
      view.focus();
    });
  }

  mounted = { reset };
}

/** Exposed for the landing's own verification script. */
export function resetLiveRenderDemo(): void {
  mounted?.reset();
}
