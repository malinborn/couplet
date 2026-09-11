import { keymap, drawSelection, highlightActiveLine, ViewPlugin } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { codeFolding, foldKeymap, syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { Strikethrough, Table } from '@lezer/markdown';
import { editorTheme } from '../theme/editor-theme';
import { markdownKeybindings } from './keybindings';
import { listContinuation } from './autocomplete';
import { slashCommands } from './slash-commands';
import { livePreviewPlugin } from './preview/plugin';
import { tableModeField } from './preview/table-state';
import { mermaidViewField } from './preview/mermaid-state';
import { tableSelectionSnapOut } from './preview/table-selection';
import { hoverBlockMenu } from './hover-menu';
import { markdownFoldService, headingFoldClick, headingFoldStatePlugin } from './folding';
import { headingSlugsField, navigateToHeading } from './heading-slugs';
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

export function createExtensions(): Extension[] {
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
    listContinuation(),
    slashCommands(),
    autocompletion(),
    markdownKeybindings(),
    history(),
    closeBrackets(),
    languageCompartment.of(
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: [Strikethrough, Table],
      })
    ),
    keymap.of([
      ...foldKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...closeBracketsKeymap,
      ...searchKeymap,
    ]),
    markdownFoldService,
    codeFolding(),
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
    // Click on rendered links opens URL in browser (mousedown to fire before CM6 removes decoration)
    EditorView.domEventHandlers({
      mousedown(event: MouseEvent, view: EditorView) {
        if (event.button !== 0) return false; // left click only
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
          if (url.startsWith('#')) {
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
