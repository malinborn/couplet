<script lang="ts">
  import type { ToastEntry, ToastStore } from './toasts.svelte';
  import { t, plural } from './i18n';

  let {
    store,
    /**
     * Called after a toast is dismissed locally, so the caller can propagate it.
     * The update notice uses this to dismiss itself in every window at once.
     */
    onDismiss,
    /**
     * Applies the pending JSON expansion (#30). Supplied by the window shell,
     * which owns the editor handle — this component stays presentational.
     */
    onFormatJson,
    /** «Перейти» on a `tabs-moved` toast: bring that window forward (`reveal_other_window`). */
    onRevealWindow,
  }: {
    store: ToastStore;
    onDismiss?: (entry: ToastEntry) => void;
    onFormatJson?: () => void;
    onRevealWindow?: (label: string) => void;
  } = $props();

  function dismiss(entry: ToastEntry): void {
    store.dismiss(entry.id);
    onDismiss?.(entry);
  }

  const SAVE_AS_BLOCKED_KEYS = {
    held: 'toast.save_as_blocked.held',
    'tab-gone': 'toast.save_as_blocked.tab_gone',
    unavailable: 'toast.save_as_blocked.unavailable',
  } as const;

  const BREW_CMD = 'brew update && brew upgrade --cask mdmini';

  let copied = $state(false);

  function copyBrewCommand(): void {
    navigator.clipboard.writeText(BREW_CMD);
    copied = true;
    setTimeout(() => { copied = false; }, 1500);
  }

  /**
   * The nudge's call to action opens the same document the AI menu's first item
   * opens, then retires itself — following it counts as having been seen.
   */
  async function openGettingStarted(entry: ToastEntry): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('ai_open_getting_started').catch(() => {
      // Opening a help document is best-effort; never surface a failure here.
    });
    dismiss(entry);
  }

  async function restoreSession(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('restore_session').catch((err: unknown) => {
      console.error('Failed to restore session:', err);
    });
  }
</script>

{#if store.toasts.length > 0}
  <div class="md-toast-stack">
    {#each store.toasts as toast (toast.id)}
      <div
        class="md-toast"
        class:md-toast-alarm={toast.payload.kind === 'save-error' ||
          toast.payload.kind === 'comment-error' ||
          toast.payload.kind === 'language-error'}
      >
        {#if toast.payload.kind === 'save-error'}
          <!-- Names the file and quotes the OS, because the two questions this
               toast has to answer are "which document" and "why" — and the
               reason is usually actionable (permissions, a full disk, a volume
               that went away). It carries no action of its own: the next
               successful save withdraws it. -->
          <span class="md-toast-text">
            <strong>{t('toast.save_error.headline', { fileName: toast.payload.fileName })}</strong>
          </span>
          <span class="md-toast-highlight">{toast.payload.message}</span>
          <span class="md-toast-dim">{t('toast.save_error.instruction')} <kbd>⌘S</kbd></span>
        {:else if toast.payload.kind === 'comment-error'}
          <!-- Deliberately not the document's wording: ⌘S would save the
               document and leave the comment exactly where it is. The text the
               user typed is still in the box, and the next keystroke retries
               the write, so the instruction is to fix the cause and keep
               typing. The message quotes the OS and names the sidecar. -->
          <span class="md-toast-text">
            <strong>{t('toast.comment_error.headline', { fileName: toast.payload.fileName })}</strong>
          </span>
          <span class="md-toast-highlight">{toast.payload.message}</span>
          <span class="md-toast-dim">{t('toast.comment_error.instruction')}</span>
        {:else if toast.payload.kind === 'language-error'}
          <!-- Deliberately not the document's save-error wording: this is a
               menu action, not a document write, and pressing ⌘S would do
               nothing for it. Names the failure and quotes the OS, same as
               save-error, because the cause is usually actionable
               (permissions, a full disk). No retry affordance: clicking the
               language item again is the retry. -->
          <span class="md-toast-text">
            <strong>{t('toast.language_error.headline')}</strong>
          </span>
          <span class="md-toast-highlight">{toast.payload.message}</span>
        {:else if toast.payload.kind === 'unsaved-blocked'}
          <!-- Not an alarm: nothing failed, the save is on its way. It says
               why the key did nothing and leaves with the save. -->
          <span class="md-toast-text">
            <strong>{t('toast.unsaved_blocked.headline', { fileName: toast.payload.fileName })}</strong>
          </span>
          <span class="md-toast-dim">{t('toast.unsaved_blocked.message')}</span>
        {:else if toast.payload.kind === 'open-error'}
          <span class="md-toast-text">
            <strong>{t('toast.open_error.headline', { fileName: toast.payload.fileName })}</strong>
          </span>
          <span class="md-toast-highlight">{toast.payload.message}</span>
        {:else if toast.payload.kind === 'tabs-stranded'}
          <!-- The verb agrees with how many files the line names, not with
               the count's plural category: «a, b, c +18» is plural in
               Russian even though 21 takes the "one" form. -->
          <span class="md-toast-text">
            <strong>{t(toast.payload.count === 1 ? 'toast.tabs_stranded.one' : 'toast.tabs_stranded.other', {
              fileName: toast.payload.fileNames,
            })}</strong>
          </span>
          {#if toast.payload.message}
            <span class="md-toast-highlight">{toast.payload.message}</span>
          {/if}
        {:else if toast.payload.kind === 'tabs-moved'}
          {@const moved = toast.payload}
          <span class="md-toast-text">
            {t('toast.tabs_moved.headline', { windows: moved.numbers.map((n) => `#${n ?? '?'}`).join(', ') })}
          </span>
          <button
            class="md-toast-cmd md-toast-action"
            onclick={() => {
              onRevealWindow?.(moved.label);
              dismiss(toast);
            }}
          >
            {t('toast.tabs_moved.go')}
          </button>
        {:else if toast.payload.kind === 'save-as-blocked'}
          <span class="md-toast-text">
            <strong>{t('toast.save_as_blocked.headline', { fileName: toast.payload.fileName })}</strong>
          </span>
          <span class="md-toast-dim">{t(SAVE_AS_BLOCKED_KEYS[toast.payload.reason])}</span>
        {:else if toast.payload.kind === 'window-number'}
          <span class="md-toast-text">{t('toast.window_number.taken', { number: toast.payload.number })}</span>
        {:else if toast.payload.kind === 'update'}
          <span class="md-toast-text">
            <strong>{t('toast.update.headline', { latest: toast.payload.latest })}</strong>
            <span class="md-toast-dim">({t('toast.update.current', { current: toast.payload.current })})</span>
          </span>
          <!-- What the release actually brings. A version number on its own
               never told anyone why to upgrade. Not translated — it is the
               release's own note, pulled verbatim from GitHub. -->
          {#if toast.payload.highlight}
            <span class="md-toast-highlight">{toast.payload.highlight}</span>
          {/if}
          <button class="md-toast-cmd" title={t('toast.update.copy_title')} onclick={copyBrewCommand}>
            {copied ? t('toast.update.copied') : BREW_CMD}
          </button>
        {:else if toast.payload.kind === 'update-none'}
          <!-- Answers a manual "Check for Updates…" click (#82) — the automatic
               checker stays silent on this outcome, but a click always gets a
               reply. -->
          <span class="md-toast-text">{t('toast.update_none.message')}</span>
        {:else if toast.payload.kind === 'update-check-failed'}
          <span class="md-toast-text">{t('toast.update_check_failed.message')}</span>
        {:else if toast.payload.kind === 'session'}
          <!-- One message, not a number in its own <strong> plus a hand-rolled
               ternary for the word after it — the ternary was correct for
               English only, and pluralized text can't be assembled from two
               translated halves in every language's word order anyway. -->
          <span class="md-toast-text">
            <strong>{plural(toast.payload.count, 'toast.session.windows')}</strong>
          </span>
          <!-- A button, not a ⇧⌘T hint: ⇧⌘T reopens only what was closed; the
               session has its own File menu item, with no key (tabs-questions
               Q1). The `session-restored` event retires this toast. -->
          <button class="md-toast-cmd md-toast-action" onclick={restoreSession}>
            {t('toast.session.restore_action')}
          </button>
        {:else if toast.payload.kind === 'ai-nudge'}
          <!-- The menu is named in the body text, not only on the button: a
               dismissed toast still delivers the one fact worth keeping.
               One `t()` call for the whole sentence — see the class doc on
               `toasts.svelte.ts` for why a per-node translation would produce
               ungrammatical results in languages with a different clause
               order. The catalog value carries its own <strong>/<span> markup —
               this is `{@html}`, so never pass params to this key: an
               interpolated value would render as raw HTML, not text. See the
               allowlist test in `i18n.test.ts` (`HTML_KEYS`), which is what
               actually enforces this across every locale. -->
          <span class="md-toast-text">{@html t('toast.ai_nudge.message')}</span>
          <button
            class="md-toast-cmd md-toast-action"
            onclick={() => openGettingStarted(toast)}
          >
            {t('toast.ai_nudge.action')}
          </button>
        {:else if toast.payload.kind === 'themes-nudge'}
          <!-- Меню названо в тексте, а не на кнопке: закрытый тост всё равно
               должен оставить единственный факт, ради которого он был.
               `{@html}` — never add a param to this key; see the note on the
               `ai-nudge` branch above. -->
          <span class="md-toast-text">{@html t('toast.themes_nudge.message')}</span>
        {:else if toast.payload.kind === 'json-offer'}
          <!-- The offer, not the act. Nothing has changed in the document at
               this point and nothing will until this button is clicked — a
               false positive costs exactly one ignored toast.
               `{@html}` — never add a param to this key; see the note on the
               `ai-nudge` branch above. -->
          <span class="md-toast-text">{@html t('toast.json_offer.message')}</span>
          <button
            class="md-toast-cmd md-toast-action"
            onclick={() => { onFormatJson?.(); dismiss(toast); }}
          >
            {t('toast.json_offer.action')}
          </button>
          <span class="md-toast-dim">{t('toast.json_offer.or')} <kbd>⇧⌘J</kbd></span>
        {:else if toast.payload.kind === 'ai-bind-copied'}
          <!-- Same shape as the watch notice below, and for the same reason:
               the clipboard write is invisible, and the copy is only half the
               action — the prompt still has to reach an agent.
               Both branches render `{@html}` — never add a param to either
               key; see the note on the `ai-nudge` branch above. -->
          {#if toast.payload.saved}
            <span class="md-toast-text">{@html t('toast.ai_bind_copied.saved')}</span>
          {:else}
            <span class="md-toast-text">{@html t('toast.ai_bind_copied.unsaved')}</span>
          {/if}
        {:else if toast.payload.kind === 'ai-watch-copied'}
          <!-- Says what to do next, not just that a copy happened: the
               clipboard is only half the action — the prompt still has to be
               pasted into an agent session.
               Both branches render `{@html}` — never add a param to either
               key; see the note on the `ai-nudge` branch above. -->
          {#if toast.payload.saved}
            <span class="md-toast-text">{@html t('toast.ai_watch_copied.saved')}</span>
          {:else}
            <span class="md-toast-text">{@html t('toast.ai_watch_copied.unsaved')}</span>
          {/if}
        {:else}
          <!-- `{@html}` on both spans — never add a param to either key; see
               the note on the `ai-nudge` branch above. -->
          <span class="md-toast-text">{@html t('toast.ai_first_use.message')}</span>
          <span class="md-toast-dim">{@html t('toast.ai_first_use.more')}</span>
        {/if}
        <button
          class="md-toast-close"
          title={t('toast.dismiss')}
          onclick={() => dismiss(toast)}
        >✕</button>
      </div>
    {/each}
  </div>
{/if}
