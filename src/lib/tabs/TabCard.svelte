<script lang="ts">
  /**
   * One tab in the drawer (spec §6 «Карточка вкладки»): its name, the grey
   * project/branch line, a few lines of its text; ⌘1…⌘9 and × on the right.
   * An unviewed tab shimmers AND carries a text label (spec §11). Pointer
   * gestures are delegated to the drawer (`data-tab-id`); the card reports
   * only hover, for the ~600 ms expansion. When it was last looked at or
   * changed sits at the end of the grey line (in the head row when Compact),
   * unless View → Tabs → Show Dates is off. Everything shown comes from data —
   * no `{@html}` over a file's text.
   */
  import { t } from '../i18n';
  import { highlight, hitSnippet, type Match } from './drawer-filter';
  import type { InlineSeg } from './drawer-preview';
  import type { GitInfo, TabText } from './drawer-data';
  import { lastTouched, type TabMeta } from './tab-model';
  import { formatExact, formatTouched } from './relative-time';

  let {
    tab,
    name,
    active,
    selected,
    kb,
    expanded,
    dragging,
    compact,
    showTime,
    now,
    query,
    match,
    text,
    git,
    shortcut,
    onclose,
    onhoverstart,
    onhoverend,
  }: {
    tab: TabMeta;
    name: string;
    active: boolean;
    selected: boolean;
    /** The keyboard ring: the arrows reached it, or it is the top search result. */
    kb: boolean;
    expanded: boolean;
    dragging: boolean;
    compact: boolean;
    /** View → Tabs → Show Dates. */
    showTime: boolean;
    /** The drawer's one ticking clock, so the relative time stays fresh while it is open. */
    now: number;
    query: string;
    match: Match | undefined;
    text: TabText | null;
    /** `undefined` while the project line is still being resolved. */
    git: GitInfo | null | undefined;
    /** `⌘1`…`⌘9` for the first nine visible cards. */
    shortcut: string | null;
    onclose: () => void;
    onhoverstart: () => void;
    onhoverend: () => void;
  } = $props();

  const nameSegments = $derived(highlight(name, match && match.rank < 2 ? query : ''));
  const hit = $derived(match?.rank === 2 ? highlight(hitSnippet(match.line, query), query) : null);
  const meta = $derived(tab.path === null ? { project: t('tabs.card.unsaved'), branch: null } : (git ?? null));
  // `active` is the window's active tab: it is being looked at, so it reads «just now».
  const touched = $derived(lastTouched(tab, active ? tab.id : null, now));
  const touchedLabel = $derived(showTime ? formatTouched(touched, now) : '');
  const touchedTitle = $derived(showTime ? formatExact(touched) : '');
</script>

{#snippet time(where: 'head' | 'meta')}
  {#if showTime}<time class="card-time" class:in-head={where === 'head'} datetime={new Date(touched).toISOString()} title={touchedTitle}
      >{touchedLabel}</time
    >{/if}
{/snippet}

{#snippet segments(list: InlineSeg[])}
  {#each list as s, i (i)}{#if s.code}<code>{s.text}</code>{:else if s.bold}<strong>{s.text}</strong>{:else if s.italic}<em>{s.text}</em>{:else}{s.text}{/if}{/each}
{/snippet}

{#snippet metaLine(inline: boolean)}
  {#if meta}<span>{meta.project}</span>{#if meta.branch}{inline ? ' · ' : ''}<span class="br">⎇ {meta.branch}</span>{/if}{:else}{' '}{/if}
{/snippet}

<div
  class="card"
  class:active
  class:selected
  class:kb
  class:expanded
  class:dragging
  class:ai-unread={tab.unviewed}
  class:untitled={tab.path === null}
  role="tab"
  id="tab-card-{tab.id}"
  data-tab-id={tab.id}
  aria-selected={active}
  tabindex={kb ? 0 : -1}
  onpointerenter={onhoverstart}
  onpointerleave={onhoverend}
>
  <span class="ring" aria-hidden="true"></span>
  <span class="wash" aria-hidden="true"></span>
  <div class="card-head">
    <span class="sel-dot" aria-hidden="true">✓</span>
    <span class="card-name"
      >{#each nameSegments as s, i (i)}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}</span
    >
    <span class="card-imeta">{@render metaLine(true)}</span>
    {#if tab.unviewed}<span class="ai-chip">{t('tabs.card.ai_chip')}</span>{/if}
    {@render time('head')}
    {#if shortcut}<kbd class="card-kbd">{shortcut}</kbd>{/if}
    <button
      class="card-close"
      type="button"
      tabindex="-1"
      aria-label={t('tabs.card.close', { name })}
      title={t('tabs.card.close_title')}
      onclick={(e) => {
        e.stopPropagation();
        onclose();
      }}>×</button
    >
  </div>
  <div class="card-meta"><span class="meta-main">{@render metaLine(false)}</span>{@render time('meta')}</div>
  {#if hit}
    <div class="card-preview">
      <div class="hit-l">{t('tabs.drawer.in_text')}</div>
      <div class="hit">{#each hit as s, i (i)}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}</div>
    </div>
  {:else if compact}
    {#if text?.first}<div class="card-preview"><div>{text.first}</div></div>{/if}
  {:else if text && text.preview.length > 0}
    <div class="card-preview">
      {#each text.preview as line, i (i)}
        <div>
          {#if line.kind === 'heading'}<b>{#each line.segs as s, j (j)}{s.text}{/each}</b>
          {:else if line.kind === 'quote'}<em>{@render segments(line.segs)}</em>
          {:else}{line.kind === 'task' ? (line.done ? '☑ ' : '☐ ') : line.kind === 'bullet' ? '• ' : ''}{@render segments(line.segs)}
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .card {
    position: relative;
    padding: 11px 12px 11px 16px;
    border-radius: 11px;
    background: var(--bg-base);
    border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
    cursor: default;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
    outline: none;
    transition:
      transform 0.3s var(--tabs-ease),
      opacity 0.22s ease,
      background-color 0.16s ease,
      border-color 0.16s ease,
      box-shadow 0.25s ease;
  }

  .card:hover {
    border-color: var(--border);
  }

  /* The active bar. */
  .card::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 12px;
    bottom: 12px;
    width: 3px;
    border-radius: 3px;
    background: var(--tabs-brand-grad);
    opacity: 0;
    transform: scaleY(0.4);
    transition:
      opacity 0.2s,
      transform 0.25s var(--tabs-ease);
  }

  .card.active {
    border-color: var(--border);
    box-shadow:
      0 1px 2px rgba(var(--tabs-shadow-rgb), 0.06),
      0 6px 18px rgba(var(--tabs-shadow-rgb), calc(var(--tabs-shadow-a) * 0.7));
  }

  .card.active::before {
    opacity: 1;
    transform: none;
  }

  .card.kb {
    outline: 2px solid color-mix(in oklab, var(--text-muted) 70%, transparent);
    outline-offset: 1px;
  }

  .card.expanded {
    transform: translateX(5px);
    box-shadow:
      0 2px 4px rgba(var(--tabs-shadow-rgb), 0.06),
      0 14px 32px rgba(var(--tabs-shadow-rgb), calc(var(--tabs-shadow-a) * 1.2));
    z-index: 2;
  }

  .card.dragging {
    opacity: 0.35;
  }

  .card.selected {
    background: color-mix(in oklab, var(--tabs-brand-a) 13%, var(--bg-base));
    border-color: color-mix(in oklab, var(--tabs-brand-a) 70%, transparent);
  }

  .card-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 20px;
  }

  .card-name {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 600;
    letter-spacing: -0.008em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .card.untitled .card-name {
    font-style: italic;
    font-weight: 500;
    color: var(--text-subtle);
  }

  .card-kbd {
    flex: 0 0 auto;
    opacity: 0.85;
    font-family: var(--tabs-ui);
    font-size: 10.5px;
    color: var(--text-muted);
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
  }

  .card-close {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    padding: 0;
    border-radius: 6px;
    border: 0;
    background: transparent;
    cursor: pointer;
    display: grid;
    place-items: center;
    font-family: inherit;
    font-size: 15px;
    line-height: 1;
    color: var(--text-muted);
    transition:
      background-color 0.12s,
      color 0.12s;
  }

  .card-close:hover {
    background: var(--highlight);
    color: var(--text-primary);
  }

  .card-meta {
    margin-top: 2px;
    font-size: 11.5px;
    color: var(--text-muted);
    display: flex;
    align-items: baseline;
    gap: 6px;
    white-space: nowrap;
    overflow: hidden;
  }

  /* Project and branch give way first: the time never gets squeezed. */
  .meta-main {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta-main .br {
    margin-left: 6px;
  }

  .br {
    font-family: var(--font-code);
    font-size: 10.5px;
  }

  .card-time {
    flex: 0 0 auto;
    margin-left: auto;
    font-family: var(--tabs-ui);
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* The head row's copy is for Compact, where the grey line is gone. */
  .card-time.in-head {
    display: none;
  }

  .card-preview {
    margin-top: 7px;
    font-family: var(--font-text);
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--text-subtle);
    max-height: calc(1.55em * 3);
    overflow: hidden;
    -webkit-mask-image: linear-gradient(#000 calc(100% - 1.3em), transparent);
    mask-image: linear-gradient(#000 calc(100% - 1.3em), transparent);
    transition: max-height 0.38s var(--tabs-ease);
  }

  .card.expanded .card-preview {
    max-height: calc(1.55em * 10);
  }

  .card-preview > div {
    overflow-wrap: anywhere;
  }

  .card-preview b {
    color: var(--text-primary);
    font-weight: 700;
  }

  .card-preview code {
    font-family: var(--font-code);
    font-size: 0.9em;
  }

  .card-preview .hit {
    color: var(--text-primary);
  }

  .card-preview .hit-l {
    font-family: var(--tabs-ui);
    font-size: 10.5px;
    color: var(--text-muted);
    margin-bottom: 1px;
  }

  mark {
    background: color-mix(in oklab, var(--tabs-brand-a) 24%, transparent);
    color: inherit;
    border-radius: 3px;
    padding: 0 1px;
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--tabs-brand-a) 30%, transparent);
  }

  .sel-dot {
    flex: 0 0 auto;
    width: 0;
    height: 15px;
    border-radius: 50%;
    border: 1.5px solid transparent;
    margin-right: -8px;
    display: grid;
    place-items: center;
    font-size: 9px;
    color: #fff;
    overflow: hidden;
    transition:
      width 0.18s var(--tabs-ease),
      margin 0.18s var(--tabs-ease),
      border-color 0.15s,
      background-color 0.15s;
  }

  :global(.shift) .sel-dot,
  .card.selected .sel-dot {
    width: 15px;
    margin-right: 0;
    border-color: var(--text-muted);
  }

  .card.selected .sel-dot {
    border-color: var(--tabs-brand-a);
    background: var(--tabs-brand-a);
  }

  :global(.shift) .card {
    cursor: cell;
  }

  .ai-chip {
    flex: 0 0 auto;
    font-size: 10.5px;
    font-weight: 600;
    padding: 1px 7px;
    border-radius: 999px;
    background: linear-gradient(100deg, rgba(245, 144, 225, 0.22), rgba(114, 220, 253, 0.22));
    color: var(--text-primary);
  }

  .ring,
  .wash {
    position: absolute;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.9s ease;
  }

  .ring {
    inset: -1px;
    padding: 1.5px;
    background: var(--tabs-ai-grad);
    background-size: 300% 100%;
    -webkit-mask:
      linear-gradient(#000 0 0) content-box,
      linear-gradient(#000 0 0);
    /* The shorthand resets the composite, so it goes before both composites. */
    mask:
      linear-gradient(#000 0 0) content-box,
      linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
  }

  .wash {
    inset: 0;
    background: linear-gradient(100deg, rgba(245, 144, 225, 0.1), rgba(114, 220, 253, 0.1), rgba(245, 144, 225, 0.1));
    background-size: 300% 100%;
  }

  .card.ai-unread .ring {
    opacity: 0.9;
    animation: shimmer 5s ease-in-out infinite alternate;
  }

  .card.ai-unread .wash {
    opacity: 1;
    animation: shimmer 5s ease-in-out infinite alternate;
  }

  /* View → Tabs → Compact: one line — name and grey project/branch together —
     and only the first non-empty line of the file under it (spec §6). */
  .card-imeta {
    display: none;
  }

  :global(.compact) .card {
    padding: 7px 10px 7px 16px;
    border-radius: 9px;
  }

  :global(.compact) .card::before {
    top: 8px;
    bottom: 8px;
  }

  :global(.compact) .card-meta {
    display: none;
  }

  :global(.compact) .card-time.in-head {
    display: block;
    margin-left: 0;
    font-size: 10.5px;
  }

  :global(.compact) .card-name {
    flex: 0 1 auto;
    max-width: 68%;
    font-size: 13px;
  }

  :global(.compact) .card-imeta {
    display: block;
    flex: 1 1 0;
    min-width: 0;
    font-size: 11.5px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :global(.compact) .card-preview,
  :global(.compact) .card.expanded .card-preview {
    margin-top: 1px;
    max-height: 1.55em;
    -webkit-mask-image: none;
    mask-image: none;
  }

  :global(.compact) .card-preview > div {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* One line only: a text hit shows the matching line, not its "in text:" label. */
  :global(.compact) .card-preview .hit-l {
    display: none;
  }

  :global(.compact) .card.expanded {
    transform: none;
  }

  @keyframes shimmer {
    0% {
      background-position: 0% 50%;
    }
    100% {
      background-position: 100% 50%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .card.ai-unread .ring,
    .card.ai-unread .wash {
      animation: none;
      background-position: 50% 50%;
    }
    .card,
    .card-preview {
      transition-duration: 0.01s !important;
    }
  }
</style>
