<script lang="ts">
  import type { ToastEntry, ToastStore } from './toasts.svelte';

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
  }: {
    store: ToastStore;
    onDismiss?: (entry: ToastEntry) => void;
    onFormatJson?: () => void;
  } = $props();

  function dismiss(entry: ToastEntry): void {
    store.dismiss(entry.id);
    onDismiss?.(entry);
  }

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
</script>

{#if store.toasts.length > 0}
  <div class="md-toast-stack">
    {#each store.toasts as toast (toast.id)}
      <div class="md-toast" class:md-toast-alarm={toast.payload.kind === 'save-error'}>
        {#if toast.payload.kind === 'save-error'}
          <!-- Names the file and quotes the OS, because the two questions this
               toast has to answer are "which document" and "why" — and the
               reason is usually actionable (permissions, a full disk, a volume
               that went away). It carries no action of its own: the next
               successful save withdraws it. -->
          <span class="md-toast-text">
            <strong>Could not save {toast.payload.fileName}</strong>
          </span>
          <span class="md-toast-highlight">{toast.payload.message}</span>
          <span class="md-toast-dim">Your edits are still here — fix the cause, then press <kbd>⌘S</kbd></span>
        {:else if toast.payload.kind === 'update'}
          <span class="md-toast-text">
            <strong>mdmini {toast.payload.latest}</strong> available
            <span class="md-toast-dim">(you have v{toast.payload.current})</span>
          </span>
          <!-- What the release actually brings. A version number on its own
               never told anyone why to upgrade. -->
          {#if toast.payload.highlight}
            <span class="md-toast-highlight">{toast.payload.highlight}</span>
          {/if}
          <button class="md-toast-cmd" title="Click to copy" onclick={copyBrewCommand}>
            {copied ? 'Copied!' : BREW_CMD}
          </button>
        {:else if toast.payload.kind === 'session'}
          <span class="md-toast-text">
            <strong>{toast.payload.count}</strong>
            {toast.payload.count === 1 ? 'window' : 'windows'} from your last session
          </span>
          <span class="md-toast-dim">Press <kbd>⇧⌘T</kbd> to reopen</span>
        {:else if toast.payload.kind === 'ai-nudge'}
          <!-- The menu is named in the body text, not only on the button: a
               dismissed toast still delivers the one fact worth keeping. -->
          <span class="md-toast-text">
            <strong>Your AI can drive md-mini</strong>
            <span class="md-toast-dim">— see the <strong>AI</strong> menu</span>
          </span>
          <button
            class="md-toast-cmd md-toast-action"
            onclick={() => openGettingStarted(toast)}
          >
            Getting Started
          </button>
        {:else if toast.payload.kind === 'json-offer'}
          <!-- The offer, not the act. Nothing has changed in the document at
               this point and nothing will until this button is clicked — a
               false positive costs exactly one ignored toast. -->
          <span class="md-toast-text">
            <strong>That looks like JSON</strong>
            <span class="md-toast-dim">— expand it?</span>
          </span>
          <button
            class="md-toast-cmd md-toast-action"
            onclick={() => { onFormatJson?.(); dismiss(toast); }}
          >
            Format
          </button>
          <span class="md-toast-dim">or <kbd>⇧⌘J</kbd></span>
        {:else if toast.payload.kind === 'ai-bind-copied'}
          <!-- Same shape as the watch notice below, and for the same reason:
               the clipboard write is invisible, and the copy is only half the
               action — the prompt still has to reach an agent. -->
          {#if toast.payload.saved}
            <span class="md-toast-text">
              <strong>Prompt copied</strong>
              <span class="md-toast-dim">— send it to your AI agent to connect it to this file</span>
            </span>
          {:else}
            <span class="md-toast-text">
              <strong>Save the file first</strong>
              <span class="md-toast-dim">— an agent needs a path to open</span>
            </span>
          {/if}
        {:else if toast.payload.kind === 'ai-watch-copied'}
          <!-- Says what to do next, not just that a copy happened: the
               clipboard is only half the action — the prompt still has to be
               pasted into an agent session. -->
          {#if toast.payload.saved}
            <span class="md-toast-text">
              <strong>Watch command copied</strong>
              <span class="md-toast-dim">— paste it into your agent's session</span>
            </span>
          {:else}
            <span class="md-toast-text">
              <strong>Save the file first</strong>
              <span class="md-toast-dim">— an unsaved document has no path to watch</span>
            </span>
          {/if}
        {:else}
          <span class="md-toast-text">
            <strong>That was your AI</strong>
            <span class="md-toast-dim">— md-mini is connected</span>
          </span>
          <span class="md-toast-dim">More in the <strong>AI</strong> menu → Getting Started</span>
        {/if}
        <button
          class="md-toast-close"
          title="Dismiss"
          onclick={() => dismiss(toast)}
        >✕</button>
      </div>
    {/each}
  </div>
{/if}
