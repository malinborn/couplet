import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createExtensions } from '@app/lib/editor/setup';

export interface DemoEditorOptions {
  /** Markdown shown in the demo. */
  doc: string;
  /** Extra extensions (demo-specific keymaps, effects, etc.). */
  extensions?: Extension[];
  /** Max visible height in px; the card clips beyond it. */
  height?: number;
  /**
   * Opt out of the read-only exhibit and hand the visitor a real editor.
   *
   * Exactly one demo does this — the live-render block, where the whole claim
   * ("the markers go away as you type, and the markup underneath survives it")
   * is a claim about *typing*. A scripted playback of that is a video, and a
   * video of an editor is precisely what this site refuses to ship. Every other
   * demo stays read-only: they narrate an agent's actions, and a visitor typing
   * into them would only fight the script.
   *
   * The card carrying this must also undo three rules `landing.css` applies to
   * `.demo` — the hidden `.cm-cursor`, the clipped `.cm-scroller`, and the
   * bottom fade — otherwise the visitor types into an invisible caret inside a
   * box that cannot scroll to follow it. See `demo-liverender.css`.
   */
  editable?: boolean;
}

export interface DemoEditor {
  view: EditorView;
  destroy: () => void;
}

/**
 * Mounts a real app editor as a non-interactive exhibit.
 *
 * readOnly blocks user input while still allowing programmatic dispatch, which
 * is what the scripted demos use. editable:false drops contenteditable so the
 * page never steals focus or shows a caret — the AI ask widget's own buttons and
 * input keep working because they are plain DOM with their own listeners.
 *
 * The selection is parked on the last line: cursorInRange() in the preview
 * layer reveals raw markdown wherever the cursor sits, and the default anchor of
 * 0 would leave line 1 unrendered. Every demo doc therefore ends with a blank
 * line to park on.
 */
export function mountDemoEditor(parent: HTMLElement, options: DemoEditorOptions): DemoEditor {
  parent.classList.add('md-editor-host');

  const doc = options.doc.endsWith('\n\n') ? options.doc : `${options.doc}\n\n`;

  const interactive = options.editable === true;

  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [
      createExtensions(),
      ...(interactive
        ? []
        : [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
      ...(options.extensions ?? []),
    ],
  });

  const view = new EditorView({ state, parent });
  if (options.height) parent.style.setProperty('--demo-h', `${options.height}px`);

  return { view, destroy: () => view.destroy() };
}

/** True when the visitor asked for less motion; looping demos must respect it. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
