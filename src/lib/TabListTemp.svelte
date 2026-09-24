<!--
  TEMPORARY — tabs plan 02 only. A bare list to see and drive a window's
  tabs until plan 03's drawer replaces it wholesale
  (docs/investigations/2026-09-24-tabs-mockup/drawer.html). No design, no
  keyboard model, no a11y roles on purpose: do not build on it.
-->
<script lang="ts">
  import type { TabListState } from './tabs/tab-model';
  import { t } from './i18n';

  let {
    list,
    activeDirty,
    onactivate,
    onclose,
  }: {
    list: TabListState;
    /** The active tab's dirty flag lives in `fileState`, not in the list. */
    activeDirty: boolean;
    onactivate: (tabId: string) => void;
    onclose: (tabId: string) => void;
  } = $props();

  function name(path: string | null): string {
    return path ? (path.split('/').pop() ?? path) : t('ui.untitled');
  }
</script>

{#if list.tabs.length > 1}
  <nav class="tab-list-temp" data-testid="tab-list-temp">
    {#each list.tabs as tab, i (tab.id)}
      {@const active = tab.id === list.activeId}
      <div class="tab" class:active data-tab-id={tab.id}>
        <button class="name" title={tab.path ?? ''} onclick={() => onactivate(tab.id)}>
          {#if i < 9}<span class="key">⌘{i + 1}</span>{/if}{(active ? activeDirty : tab.dirty)
            ? '● '
            : ''}{name(tab.path)}
        </button>
        <button class="close" data-testid="tab-close" onclick={() => onclose(tab.id)}>×</button>
      </div>
    {/each}
  </nav>
{/if}

<style>
  .tab-list-temp {
    position: fixed;
    left: 8px;
    bottom: 8px;
    z-index: 870;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 40vw;
    max-height: 50vh;
    overflow-y: auto;
    padding: 4px 6px;
    font: 11px/1.5 var(--font-text);
    color: var(--text-muted);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .tab.active .name {
    color: var(--text-primary);
    font-weight: 600;
  }

  button {
    all: unset;
    cursor: pointer;
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .key {
    margin-right: 6px;
    opacity: 0.6;
  }

  .close {
    padding: 0 4px;
    opacity: 0.5;
  }

  .close:hover {
    opacity: 1;
  }
</style>
