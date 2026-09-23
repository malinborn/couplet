<script lang="ts">
  /**
   * Top-right hint pointing at Esc while an AI-edit highlight is visible.
   * Never intercepts input — it's purely informational, so pointer-events
   * stays off even while faded in.
   */
  import { t } from './i18n';

  let { visible }: { visible: boolean } = $props();
</script>

<div class="ai-hint-badge" class:ai-hint-visible={visible} aria-hidden="true">
  <kbd>Esc</kbd><span>{t('ui.ai_hint.text')}</span>
</div>

<style>
  .ai-hint-badge {
    position: fixed;
    right: 14px;
    top: 14px;
    z-index: 900;
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--color-code-bg);
    border: 1px solid var(--color-table-border);
    border-radius: 999px;
    padding: 5px 12px;
    font-family: var(--font-code);
    font-size: 12px;
    color: var(--text-primary);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s ease;
  }

  .ai-hint-badge.ai-hint-visible {
    opacity: 0.92;
  }

  .ai-hint-badge kbd {
    font-family: var(--font-code);
    font-size: 11px;
    border: 1px solid var(--color-table-border);
    border-radius: 4px;
    padding: 1px 5px;
  }
</style>
