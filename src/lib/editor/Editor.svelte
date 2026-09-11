<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorView } from '@codemirror/view';
  import { ChangeSet, EditorState, Transaction } from '@codemirror/state';
  import { createExtensions, languageCompartment, previewCompartment } from './setup';
  import { languages } from '@codemirror/language-data';
  import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
  import { findCodeLanguage, isShellConfig } from './file-language';
  import { shellSecretsPlugin } from './preview/shell-secrets';
  import { Strikethrough, Table } from '@lezer/markdown';
  import { livePreviewPlugin } from './preview/plugin';
  import { envPreviewPlugin } from './preview/env';
  import { computeReplacement } from './content-diff';
  import { aiHighlightPresenceNotifier } from './ai-highlight';
  import { jsonPasteNotifier } from './json-paste';
  import '../../styles/editor-metrics.css';

  export interface EditorHandle {
    view: EditorView | undefined;
    replaceContent: (newContent: string) => void;
    updateContent: (newContent: string) => void;
    setCodeMode: (ext: string | null, basename?: string) => void;
    setEnvMode: (enabled: boolean) => void;
  }

  let {
    onchange,
    onAiHighlightVisibilityChange,
    onJsonOffer,
    onJsonOfferWithdrawn,
    handle = $bindable(),
  }: {
    onchange?: (doc: string) => void;
    onAiHighlightVisibilityChange?: (visible: boolean) => void;
    /** Pasted content parses as JSON worth expanding — raise the offer toast. */
    onJsonOffer?: () => void;
    /** The pending offer stopped being applicable — take the toast down. */
    onJsonOfferWithdrawn?: () => void;
    handle?: EditorHandle;
  } = $props();

  let editorContainer: HTMLDivElement;
  let view: EditorView | undefined = $state(undefined);

  $effect(() => {
    handle = {
      get view() {
        return view;
      },
      replaceContent(newContent: string) {
        if (!view) return;
        const docLen = view.state.doc.length;
        view.dispatch({
          changes: { from: 0, to: docLen, insert: newContent },
          selection: newContent.length > 0 ? { anchor: newContent.length } : undefined,
          annotations: Transaction.addToHistory.of(false),
        });
        if (newContent.length > 0) {
          view.contentDOM.blur();
        }
      },
      updateContent(newContent: string) {
        if (!view) return;
        const repl = computeReplacement(view.state.doc.toString(), newContent);
        if (!repl) return;
        // Single-span diff keeps CM6's automatic selection mapping intact and
        // preserves scroll position — unlike replaceContent's full-doc swap.
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
      setCodeMode(ext: string | null, basename?: string) {
        if (!view) return;
        if (!ext) {
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
          return;
        }
        // Find language by basename (extensionless dotfiles) or extension
        const lang = findCodeLanguage(basename ?? '', ext);
        if (lang) {
          lang.load().then(langSupport => {
            if (!view) return;
            view.dispatch({
              effects: [
                languageCompartment.reconfigure(langSupport),
                previewCompartment.reconfigure(
                  isShellConfig(basename ?? '') ? shellSecretsPlugin : []
                ),
              ],
            });
            view.dom.classList.add('cm-code-file-mode');
          });
        }
      },
      setEnvMode(enabled: boolean) {
        if (!view) return;
        if (enabled) {
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
    const state = EditorState.create({
      doc: '',
      extensions: [
        ...createExtensions(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onchange) {
            onchange(update.state.doc.toString());
          }
        }),
        // Same "append at construction time via a prop callback" pattern as the
        // onchange listener above — createExtensions() is a static list shared by
        // every consumer, so per-window callbacks are wired here instead.
        aiHighlightPresenceNotifier((visible) => onAiHighlightVisibilityChange?.(visible)),
        jsonPasteNotifier({
          onOffer: () => onJsonOffer?.(),
          onWithdraw: () => onJsonOfferWithdrawn?.(),
        }),
      ],
    });

    view = new EditorView({
      state,
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
