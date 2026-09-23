<script lang="ts">
  import type { RecentFile } from './stores.svelte';
  import { t } from './i18n';

  interface Props {
    files: RecentFile[];
    onopen: (path: string) => void;
    onclose: () => void;
  }

  let { files, onopen, onclose }: Props = $props();

  function formatPath(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1];
  }

  function formatDir(path: string): string {
    const parts = path.split('/');
    return parts.slice(0, -1).join('/').replace(/^\/Users\/[^/]+/, '~');
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      onclose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Backdrop -->
<div
  class="backdrop"
  role="button"
  tabindex="-1"
  onclick={onclose}
  onkeydown={(e) => e.key === 'Enter' && onclose()}
></div>

<!-- Panel -->
<div class="panel" role="dialog" aria-label={t('ui.recent_files.title')} aria-modal="true">
  <div class="panel-header">
    <span class="panel-title">{t('ui.recent_files.title')}</span>
    <button class="close-btn" onclick={onclose} aria-label={t('ui.recent_files.close')}>&#x2715;</button>
  </div>

  {#if files.length === 0}
    <div class="empty">{t('ui.recent_files.empty')}</div>
  {:else}
    <ul class="file-list">
      {#each files as file (file.path)}
        <li>
          <button
            class="file-item"
            onclick={() => { onopen(file.path); onclose(); }}
          >
            <span class="file-name">{formatPath(file.path)}</span>
            <span class="file-dir">{formatDir(file.path)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 100;
  }

  .panel {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 101;
    background: var(--bg-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    width: 480px;
    max-height: 480px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    overflow: hidden;
    font-family: var(--font-text);
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .panel-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1rem;
    padding: 2px 6px;
    border-radius: 4px;
    line-height: 1;
  }

  .close-btn:hover {
    background: var(--highlight);
    color: var(--text-primary);
  }

  .empty {
    padding: 24px 16px;
    color: var(--text-muted);
    font-size: 0.9rem;
    text-align: center;
  }

  .file-list {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow-y: auto;
    flex: 1;
  }

  .file-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    padding: 8px 16px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    gap: 2px;
  }

  .file-item:hover {
    background: var(--highlight);
  }

  .file-name {
    color: var(--text-primary);
    font-size: 0.9rem;
  }

  .file-dir {
    color: var(--text-muted);
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
</style>
