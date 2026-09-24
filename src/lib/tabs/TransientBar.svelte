<script lang="ts">
  import { t } from '../i18n';

  /**
   * A quick look's question (spec §7), over the document while its tab is
   * the active one. «Закрыть» closes the tab (⌘⇧T brings it back);
   * «Оставить» makes it an ordinary tab. Answered here: nothing goes back to
   * the agent. First draft of the visual — to be shown to the owner.
   */
  let { visible, onclose, onkeep }: { visible: boolean; onclose: () => void; onkeep: () => void } = $props();
</script>

{#if visible}
  <div class="transient-bar" role="status" aria-label={t('tabs.transient.label')}>
    <span class="label">✦ {t('tabs.transient.label')}</span>
    <button type="button" class="close" onclick={onclose}>{t('tabs.transient.close')}</button>
    <button type="button" class="keep" onclick={onkeep}>{t('tabs.transient.keep')}</button>
  </div>
{/if}

<style>
  .transient-bar {
    position: fixed;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    /* Over the document, under the drawer (900) and its scrim (850 < this < 880 the AI button). */
    z-index: 860;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 6px 5px 14px;
    border-radius: 999px;
    /* The ask tint is translucent: laid over the page colour, or text shows through. */
    background: linear-gradient(var(--ai-ask-bg), var(--ai-ask-bg)), var(--bg-base);
    border: 1px solid var(--ai-ask-border);
    color: var(--text-primary);
    font-family: var(--font-text);
    font-size: 13px;
    line-height: 1.2;
    white-space: nowrap;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
  }

  .label {
    color: var(--text-muted);
    margin-right: 4px;
  }

  button {
    font: inherit;
    border: 1px solid var(--ai-ask-border);
    border-radius: 999px;
    padding: 4px 12px;
    cursor: pointer;
    background: transparent;
    color: var(--text-primary);
  }

  .keep {
    background: var(--ai-ask-accent);
    border-color: var(--ai-ask-accent);
    color: var(--ai-ask-accent-text);
  }
</style>
