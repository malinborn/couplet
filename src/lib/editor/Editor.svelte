<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorView, type ViewUpdate } from '@codemirror/view';
  import { ChangeSet, EditorState, Transaction, type Extension, type StateEffect } from '@codemirror/state';
  import { languageCompartment, previewCompartment } from './setup';
  import { createDocumentState } from './state-factory';
  import { latestOnly } from './latest-only';
  import { themePickerField, type ThemeControl } from './slash-theme';
  import { languages } from '@codemirror/language-data';
  import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
  import { findCodeLanguage } from './file-language';
  import { Strikethrough, Table } from '@lezer/markdown';
  import { livePreviewPlugin } from './preview/plugin';
  import { envPreviewPlugin } from './preview/env';
  import { computeReplacement } from './content-diff';
  import { normalizeLineEndings } from '../line-endings';
  import { aiHighlightPresenceNotifier, notifyHighlightPresenceChange } from './ai-highlight';
  import { jsonOfferField, jsonPasteNotifier } from './json-paste';
  import { jsonDocumentPath, setDocumentPath } from './json-fence';
  import { hideHoverMenu } from './hover-menu';
  import '../../styles/editor-metrics.css';

  export interface SwapOptions {
    blur?: boolean;
    /**
     * Where the swapped-in state is scrolled to: the top (the default), or a
     * snapshot taken with `view.scrollSnapshot()` while that state was shown.
     * `setState` keeps the scroller's pixel offset otherwise, which would open
     * a document at wherever the previous one had been scrolled to.
     */
    scroll?: 'top' | StateEffect<unknown>;
  }

  export interface EditorHandle {
    view: EditorView | undefined;
    /** A fresh state for `doc` with this view's listeners; caret at `cursor`, or the end. */
    createState: (doc: string, cursor: number | null) => EditorState;
    /**
     * Show `state` — a fresh one or a background tab's cached one. `blur`
     * mirrors what a file load always did: a non-empty document does not
     * start with a blinking caret stealing focus.
     *
     * Everything a state carries in its own compartments — language, preview
     * plugin, line glow — and the document path field arrive as that state
     * holds them; the caller re-applies the window's current configuration.
     */
    swapState: (state: EditorState, opts?: SwapOptions) => void;
    updateContent: (newContent: string) => void;
    /**
     * The language for `ext` (`null`: markdown). A code language loads
     * asynchronously and touches only the language compartment and the
     * code-file class — the preview compartment is the caller's
     * (`applyPreviewConfig` in App.svelte). Resolves `true` once the language
     * is on the state that asked for it, `false` when there is none or a newer
     * mode or state superseded it.
     */
    setCodeMode: (ext: string | null, basename?: string) => Promise<boolean>;
    setEnvMode: (enabled: boolean) => void;
    /**
     * Tell the editor which file it is showing; `null` for untitled.
     *
     * Read by the JSON formatter to decide whether its result may be wrapped
     * in a ```json fence — a decision that must never be taken from the
     * editor's active language, because a code language is loaded
     * asynchronously and, for an unrecognised extension, never at all.
     */
    setDocumentPath: (path: string | null) => void;
  }

  let {
    onchange,
    onAiHighlightVisibilityChange,
    onJsonOffer,
    onJsonOfferWithdrawn,
    themeControl,
    handle = $bindable(),
  }: {
    /** `update` says who changed it — see `human-edit.ts`. */
    onchange?: (doc: string, update: ViewUpdate) => void;
    onAiHighlightVisibilityChange?: (visible: boolean) => void;
    /** Pasted content parses as JSON worth expanding — raise the offer toast. */
    onJsonOffer?: () => void;
    /** The pending offer stopped being applicable — take the toast down. */
    onJsonOfferWithdrawn?: () => void;
    /**
     * Enables `/theme` in the slash menu. Omitted by `site/demos/editor-demo.ts`
     * (the landing's demo cards), which is what keeps them from repainting the
     * whole page — see `EditorDeps` in `./setup`.
     */
    themeControl?: ThemeControl;
    handle?: EditorHandle;
  } = $props();

  let editorContainer: HTMLDivElement;
  let view: EditorView | undefined = $state(undefined);
  // Every state this view shows carries the same listeners, so a cached state
  // swapped back in still reports to this component. Built before the handle
  // is published: a state created without them would never mark the buffer
  // dirty. The callbacks read the props when they fire, not now.
  const extras: Extension[] = [
    EditorView.updateListener.of((update) => {
      if (update.docChanged && onchange) {
        onchange(update.state.doc.toString(), update);
      }
    }),
    // Per-window callbacks are appended here rather than in
    // createExtensions(), which is a static list shared by every consumer.
    aiHighlightPresenceNotifier((visible) => onAiHighlightVisibilityChange?.(visible)),
    jsonPasteNotifier({
      onOffer: () => onJsonOffer?.(),
      onWithdraw: () => onJsonOfferWithdrawn?.(),
    }),
    jsonDocumentPath,
  ];
  // A language that finishes loading after its state was swapped out, or after
  // a newer mode was asked for, must not reconfigure the state now showing.
  const languageLoads = latestOnly();

  $effect(() => {
    handle = {
      get view() {
        return view;
      },
      createState(doc: string, cursor: number | null) {
        return createDocumentState(doc, cursor, extras, { themeControl });
      },
      swapState(state: EditorState, opts?: SwapOptions) {
        if (!view) return;
        const previous = view.state;
        languageLoads.invalidate();
        // The popup belongs to a line of the state that is leaving.
        hideHoverMenu();
        view.setState(state);
        const scroll = opts?.scroll ?? 'top';
        if (scroll === 'top') view.scrollDOM.scrollTop = 0;
        else view.dispatch({ effects: scroll });
        // `setState` runs no update listeners, so the highlight hint would keep
        // describing the state that just left.
        notifyHighlightPresenceChange(previous, state, (visible) =>
          onAiHighlightVisibilityChange?.(visible)
        );
        // Same for the JSON offer: its toast would stay up over a state with no offer to apply.
        if (previous.field(jsonOfferField, false) && !state.field(jsonOfferField, false)) {
          onJsonOfferWithdrawn?.();
        }
        // And for a `/theme` preview: only the picker's listener ends it. The
        // controller strips the state before it leaves (`stripLeavingState`);
        // this covers a swap that did not go through it.
        if (previous.field(themePickerField, false)) themeControl?.previewFamily(null);
        if (opts?.blur && state.doc.length > 0) view.contentDOM.blur();
      },
      updateContent(newContent: string) {
        if (!view) return;
        // The buffer is LF-only; diffing it against text that still carries
        // `\r` would treat every line ending as changed. Callers pass text
        // from `readDocument`, already normalized — this is the backstop.
        const repl = computeReplacement(view.state.doc.toString(), normalizeLineEndings(newContent));
        if (!repl) return;
        // Single-span diff keeps CM6's automatic selection mapping intact and
        // preserves scroll position — unlike a whole-state swap.
        // scrollSnapshot() captures the anchor at pre-change offsets; it must be
        // mapped through the same ChangeSet passed to dispatch, or a length-changing
        // edit above the viewport leaves the anchor pointing at the wrong position.
        const changes = ChangeSet.of(repl, view.state.doc.length);
        view.dispatch({
          changes,
          effects: view.scrollSnapshot().map(changes) ?? [],
          annotations: Transaction.addToHistory.of(false),
        });
      },
      setCodeMode(ext: string | null, basename?: string): Promise<boolean> {
        if (!view) return Promise.resolve(false);
        if (!ext) {
          languageLoads.invalidate();
          // Back to markdown mode
          view.dispatch({
            effects: [
              languageCompartment.reconfigure(
                markdown({
                  base: markdownLanguage,
                  codeLanguages: languages,
                  extensions: [Strikethrough, Table],
                })
              ),
              previewCompartment.reconfigure(livePreviewPlugin),
            ],
          });
          view.dom.classList.remove('cm-code-file-mode');
          return Promise.resolve(true);
        }
        // Find language by basename (extensionless dotfiles) or extension
        const lang = findCodeLanguage(basename ?? '', ext);
        if (!lang) return Promise.resolve(false);
        const isCurrent = languageLoads.begin();
        return lang.load().then(
          (langSupport) => {
            if (!view || !isCurrent()) return false;
            view.dispatch({ effects: languageCompartment.reconfigure(langSupport) });
            view.dom.classList.add('cm-code-file-mode');
            return true;
          },
          (err: unknown) => {
            console.error('Failed to load language:', err);
            return false;
          }
        );
      },
      setDocumentPath(path: string | null) {
        if (!view) return;
        view.dispatch({ effects: setDocumentPath.of(path) });
      },
      setEnvMode(enabled: boolean) {
        if (!view) return;
        if (enabled) {
          languageLoads.invalidate();
          view.dispatch({
            effects: [
              languageCompartment.reconfigure([]),
              previewCompartment.reconfigure(envPreviewPlugin),
            ],
          });
          view.dom.classList.remove('cm-code-file-mode');
        } else {
          // Revert handled by setCodeMode(null) — no extra work needed
        }
      },
    };
  });

  onMount(() => {
    view = new EditorView({
      state: createDocumentState('', 0, extras, { themeControl }),
      parent: editorContainer,
    });

    view.focus();

    return () => {
      view?.destroy();
    };
  });
</script>

<div class="editor-container md-editor-host" bind:this={editorContainer}></div>

<style>
  .editor-container {
    height: 100vh;
    width: 100%;
    overflow: auto;
  }

  .editor-container :global(.cm-editor) {
    height: 100%;
  }
</style>
