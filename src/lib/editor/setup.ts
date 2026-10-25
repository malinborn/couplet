import { DEFAULT_LIST_LAYOUT, listLayoutExtension } from './preview/explicit-lists';
import { keymap, drawSelection, highlightActiveLine, ViewPlugin } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
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
import { stashAction, type StashControl } from './slash-stash';
import { livePreviewPlugin } from './preview/plugin';
import { tableModeField } from './preview/table-state';
import { mermaidViewField } from './preview/mermaid-state';
import { tableSelectionSnapOut } from './preview/table-selection';
import { tableCellScroll } from './preview/table-scroll';
import { hoverBlockMenu } from './hover-menu';
import { markdownFoldService, headingFoldClick, headingFoldStatePlugin } from './folding';
import { foldMemory } from './fold-memory';
import { headingSlugsField } from './heading-slugs';
import { linkControlFacet, linkUrlAt, openLink, type LinkControl } from './links/open-link';
import { linkExistence } from './links/link-existence';
import { createFileLinkSource } from './links/file-link-source';
import { linkAction } from './links/slash-link';
import { linkDropCaret } from './links/link-drop';
import { aiHighlightField, aiHighlightKeymap } from './ai-highlight';
import { aiAskField } from './ai-ask';
import { aiCommentAttention, aiCommentField } from './ai-comment';
import { jsonFormatKeymap, jsonOfferField } from './json-paste';
import { mathGhost } from './math/ghost';
import { findPanel } from './search/panel';
import { searchSpotlight } from './search/spotlight';
import { readOnlyCompartment } from './read-only';

export const previewCompartment = new Compartment();
export const languageCompartment = new Compartment();

/**
 * Marks a code file (`.py`, `.json`, …) for CSS — the `.tok-link` colours.
 * Installed into `languageCompartment` with the language, so it belongs to the
 * state and leaves with it. Not a `classList` toggle: CM6 rebuilds the editor's
 * `class` attribute on every focus change, and the first click wiped a class
 * added that way (the grey box that vanished on click).
 */
export const codeFileModeAttr = EditorView.editorAttributes.of({ class: 'cm-code-file-mode' });
export const lineGlowCompartment = new Compartment();
/** View → Lists: `listLayoutExtension(layout)`. */
export const listLayoutCompartment = new Compartment();

// Moved to `links/open-link.ts`, where the link router lives; re-exported for
// existing importers.
export { openExternalUrl } from './links/open-link';

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
  /** Enables `/stash` (⌃T's put-away). Omitted by the landing's demo cards. */
  stashControl?: StashControl;
  /**
   * File links (file-links D3): ⌘-click on `[x](plan.md)` opens the file, the
   * existence check marks missing targets. Omitted by the landing's demo
   * cards, which keep the old external-only behaviour.
   */
  linkControl?: LinkControl;
}

export function createExtensions(deps: EditorDeps = {}): Extension[] {
  const { themeControl, stashControl, linkControl } = deps;
  const actions: SlashAction[] = [
    ...(themeControl ? [themeAction(themeControl), toneAction(themeControl)] : []),
    ...(stashControl ? [stashAction(stashControl)] : []),
    ...(linkControl ? [linkAction()] : []),
  ];

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
    // `338 * 1.3 =` → grey `439.4` at the caret, Tab writes it (math/ghost.ts).
    mathGhost(),
    lineGlowCompartment.of([]),
    readOnlyCompartment.of([]),
    drawSelection(),
    // Prec.highest, and it has to sit outside previewCompartment: the two-Enter
    // exit from a fenced code block applies to every engine (#52).
    codeBlockExitKeymap,
    listContinuation(),
    slashCommands(actions),
    // `[[` file picker (file-links D5). One source per state, built here once.
    ...(linkControl ? [createFileLinkSource(linkControl).extension] : []),
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
    // ⌘F: the compact Find panel with a match counter, and the spotlight that
    // dims the document around the matches while typing in it.
    findPanel(),
    searchSpotlight(),
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
    ...(linkControl ? [linkControlFacet.of(linkControl), linkExistence, linkDropCaret] : []),
    listLayoutCompartment.of(listLayoutExtension(DEFAULT_LIST_LAYOUT)),
    tableSelectionSnapOut,
    // Scrolling to a position in a table body (⌘G onto a match) goes to the
    // cell: the row's own line is a zero-height strip at the table's bottom.
    tableCellScroll,
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

        const url = linkUrlAt(view.state, pos);
        if (url) {
          event.preventDefault();
          event.stopPropagation();
          // One router for every gesture (file-links D3): anchors, URLs,
          // files, missing files — see `links/open-link.ts`.
          void openLink(view, url);
          return true;
        }
        return false;
      },
    }),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(false),
  ];
}
