import { keymap, drawSelection, highlightActiveLine, ViewPlugin } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { codeFolding, foldKeymap, syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { editorTheme } from '../theme/editor-theme';
import { markdownExtension } from './markdown-language';
import { markdownKeybindings } from './keybindings';
import { listContinuation } from './autocomplete';
import { codeBlockExitKeymap } from './code-block-exit';
import { slashCommands } from './slash-commands';
import type { SlashAction } from './slash-actions';
import { themeAction, themePickerExtensions, renderThemeSwatch, type ThemeControl } from './slash-theme';
import { toneAction, tonePickerExtensions } from './slash-tone';
import { livePreviewPlugin } from './preview/plugin';
import { tableModeField } from './preview/table-state';
import { mermaidViewField } from './preview/mermaid-state';
import { tableSelectionSnapOut } from './preview/table-selection';
import { hoverBlockMenu } from './hover-menu';
import { markdownFoldService, headingFoldClick, headingFoldStatePlugin } from './folding';
import { foldMemory } from './fold-memory';
import { headingSlugsField, isAnchor, navigateToHeading } from './heading-slugs';
import { aiHighlightField, aiHighlightKeymap } from './ai-highlight';
import { aiAskField } from './ai-ask';
import { aiCommentAttention, aiCommentField } from './ai-comment';
import { jsonFormatKeymap, jsonOfferField } from './json-paste';

export const previewCompartment = new Compartment();
export const languageCompartment = new Compartment();
export const lineGlowCompartment = new Compartment();

/**
 * Opens a rendered link. Uses the Tauri shell plugin in the app; falls back to
 * a browser tab when that plugin has no backend (the landing page embeds this
 * same editor). The plugin call must be returned so its rejection reaches the
 * catch — otherwise the fallback never runs.
 */
export function openExternalUrl(url: string): Promise<void> {
  return import('@tauri-apps/plugin-shell')
    .then(({ open }) => open(url))
    .catch(() => {
      window.open(url, '_blank');
    });
}

/**
 * Injected rather than imported: `createExtensions()` is called by both
 * `Editor.svelte` and `site/demos/editor-demo.ts` (the couplet.pro landing's
 * demo cards). A direct import of the app's theme store would pull
 * `localStorage`/`matchMedia` onto the landing at module load time and give
 * the demo editor the ability to repaint the whole page. Without
 * `themeControl`, neither `/theme` nor `/tone` appears in the slash menu at
 * all — see `slash-theme.ts` and `slash-tone.ts`.
 */
export interface EditorDeps {
  themeControl?: ThemeControl;
}

export function createExtensions(deps: EditorDeps = {}): Extension[] {
  const { themeControl } = deps;
  const actions: SlashAction[] = themeControl
    ? [themeAction(themeControl), toneAction(themeControl)]
    : [];

  return [
    editorTheme,
    tableModeField,
    mermaidViewField,
    headingSlugsField,
    aiHighlightField,
    aiHighlightKeymap,
    aiAskField,
    aiCommentField,
    aiCommentAttention,
    jsonOfferField,
    jsonFormatKeymap,
    lineGlowCompartment.of([]),
    drawSelection(),
    // Prec.highest, and it has to sit outside previewCompartment: the two-Enter
    // exit from a fenced code block applies to every engine (#52).
    codeBlockExitKeymap,
    listContinuation(),
    slashCommands(actions),
    ...(themeControl ? themePickerExtensions(themeControl) : []),
    ...(themeControl ? tonePickerExtensions(themeControl) : []),
    autocompletion(
      themeControl
        ? {
            // Icons default to position 20, the label to 50 — the swatch pair
            // sits between them. Gated inside renderThemeSwatch on
            // `completion.type`, since `addToOptions` is global to this one
            // `autocompletion()` call and would otherwise run for every
            // completion in the app, including `/tone`'s and language ones.
            // `/tone` has no swatches — renderThemeSwatch returns null for it.
            addToOptions: [{ render: renderThemeSwatch, position: 30 }],
          }
        : {}
    ),
    markdownKeybindings(),
    history(),
    closeBrackets(),
    languageCompartment.of(markdownExtension()),
    keymap.of([
      ...foldKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...closeBracketsKeymap,
      ...searchKeymap,
    ]),
    markdownFoldService,
    codeFolding(),
    foldMemory,
    headingFoldClick,
    headingFoldStatePlugin,
    syntaxHighlighting(classHighlighter),
    previewCompartment.of(livePreviewPlugin),
    tableSelectionSnapOut,
    hoverBlockMenu(),
    // Hide gutter when scrolled horizontally (buttons overlap content)
    ViewPlugin.fromClass(class {
      private handler: () => void;
      private scroller: Element;
      constructor(view: EditorView) {
        this.scroller = view.scrollDOM;
        this.handler = () => {
          view.dom.classList.toggle('cm-scrolled-x', this.scroller.scrollLeft > 0);
        };
        this.scroller.addEventListener('scroll', this.handler, { passive: true });
      }
      destroy() {
        this.scroller.removeEventListener('scroll', this.handler);
      }
    }),
    /**
     * Rendered links: **⌘/Ctrl-click opens the URL, a plain click puts the caret
     * in the text.** It used to be the other way round, with no modifier at all,
     * which meant the text of a link could not be clicked into in *either*
     * engine — the handler ran on `mousedown`, before CM6 ever saw the event,
     * and called `preventDefault` + `stopPropagation` unconditionally.
     *
     * That is the wrong default for an editor. "Click a word to fix a typo" has
     * to work on every word in the document, and a link's text is the one place
     * it silently did not; the only workaround was to select around the link
     * with the keyboard. ⌘-click as the open gesture is what every IDE already
     * does, so it needs no teaching, and the tooltip on the link says so.
     *
     * Changing it here changes live-preview too, deliberately: a split where
     * one engine opens on click and the other places a caret would make the
     * same gesture mean two things in the same app. The risk is bounded in
     * live-preview, which reveals `[text](url)` under the caret — so a plain
     * click there shows the user exactly what they clicked into, and the link
     * is still one ⌘-click away.
     */
    EditorView.domEventHandlers({
      mousedown(event: MouseEvent, view: EditorView) {
        if (event.button !== 0) return false; // left click only
        // Not `event.metaKey` alone: Ctrl is the modifier on Windows/Linux, and
        // on macOS Ctrl-click is a right-click, which the button test above has
        // already let through as `button !== 0`.
        if (!event.metaKey && !event.ctrlKey) return false;
        const target = event.target as HTMLElement;
        if (!target.closest('.cm-md-link')) return false;

        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;

        const tree = syntaxTree(view.state);
        let url = '';
        tree.iterate({
          from: Math.max(0, pos - 500),
          to: Math.min(view.state.doc.length, pos + 500),
          enter(node) {
            if (node.name === 'Link' && node.from <= pos && node.to >= pos) {
              const c = node.node.cursor();
              if (c.firstChild()) {
                do {
                  if (c.name === 'URL') {
                    url = view.state.doc.sliceString(c.from, c.to);
                  }
                } while (c.nextSibling());
              }
            }
          },
        });

        if (url) {
          event.preventDefault();
          event.stopPropagation();
          if (isAnchor(url)) {
            navigateToHeading(view, url.slice(1));
            return true;
          }
          openExternalUrl(url);
          return true;
        }
        return false;
      },
    }),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(false),
  ];
}
