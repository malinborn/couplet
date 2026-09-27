<script lang="ts">
  /**
   * One entry in the stash drawer (stash stage 04; spec «Карточка», mockup
   * `stCardHTML`): kind icon, title, «открыта в #N», the bright «отложено …»
   * line, a file's repo/branch and path, a preview, tag chips (the repo chip
   * dashed). The drawer owns pointer gestures on the card body
   * (`data-stash-id`); the card owns its buttons and the tag input, whose keys
   * are its own (`TabDrawer` skips `.tag-edit` targets). Everything shown is
   * data — no `{@html}` over user text.
   */
  import { tick } from 'svelte';
  import { t } from '../i18n';
  import { firstPlainLine, highlight, hitSnippet, type Match } from '../tabs/drawer-filter';
  import { previewLines, type InlineSeg } from '../tabs/drawer-preview';
  import StashIcon from './StashIcon.svelte';
  import { normalizeTag, TAG_MAX } from './stash-query';
  import { dropFirstLine, formatWhen, repoRelativePath, whenOf } from './stash-view';
  import type { StashEntry, TabHolder, TagChange } from './types';

  let {
    entry,
    title,
    match,
    query,
    holder,
    kb,
    expanded,
    dragging,
    compact,
    pulse,
    pulseKey = 0,
    newTags,
    now,
    onremove,
    onfilter,
    onsettag,
    ondone,
    onhoverstart,
    onhoverend,
  }: {
    entry: StashEntry;
    title: string;
    match: Match;
    /** The query's text part: what to highlight. */
    query: string;
    /** The other window holding it, or `null`. */
    holder: TabHolder | null;
    kb: boolean;
    expanded: boolean;
    dragging: boolean;
    compact: boolean;
    pulse: boolean;
    /** The store's pulse count for this card: a new one restarts the animation. */
    pulseKey?: number;
    newTags: readonly string[];
    /** For «отложено …»; ticks while the drawer is open. */
    now: number;
    onremove: () => void;
    onfilter: (tag: string) => void;
    onsettag: (change: TagChange) => void;
    /** The tag input closed: the drawer takes focus back. */
    ondone: () => void;
    onhoverstart: () => void;
    onhoverend: () => void;
  } = $props();

  let adding = $state(false);
  let draft = $state('');
  let inputEl: HTMLInputElement | undefined = $state();

  const isNote = $derived(entry.kind === 'note');
  const nameSegments = $derived(highlight(title, match.rank < 2 ? query : ''));
  const hit = $derived(match.rank === 2 ? highlight(hitSnippet(match.line, query), query) : null);
  const source = $derived(isNote ? dropFirstLine(entry.preview) : entry.preview);
  const preview = $derived(previewLines(source));
  const firstLine = $derived(firstPlainLine(source));
  const away = $derived(
    entry.stashedAt === null ? null : t('stash.card.away', { when: formatWhen(whenOf(entry.stashedAt, now)) })
  );
  const noteMeta = $derived(t('stash.card.note_meta', { when: formatWhen(whenOf(entry.modifiedAt, now)) }));
  const hasTags = $derived(entry.repo !== null || entry.tags.length > 0 || adding);

  async function startAdding(): Promise<void> {
    adding = true;
    draft = '';
    await tick();
    inputEl?.focus();
  }

  function finish(commit: boolean): void {
    if (!adding) return;
    const tag = commit ? normalizeTag(draft) : null;
    adding = false;
    draft = '';
    if (tag && !entry.tags.includes(tag)) onsettag({ add: [tag] });
    ondone();
  }

  function onTagKey(e: KeyboardEvent): void {
    // Its keys are its own: not the drawer's search, not the editor's.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  }
</script>

{#snippet segments(list: InlineSeg[])}
  {#each list as s, i (i)}{#if s.code}<code>{s.text}</code>{:else if s.bold}<strong>{s.text}</strong>{:else if s.italic}<em>{s.text}</em>{:else}{s.text}{/if}{/each}
{/snippet}

<div
  class="card"
  class:note={isNote}
  class:file={!isNote}
  class:kb
  class:expanded
  class:dragging
  class:pulse
  class:pulse-alt={pulse && pulseKey % 2 === 1}
  class:compact
  role="option"
  id="stash-card-{entry.id}"
  data-stash-id={entry.id}
  aria-selected={kb}
  tabindex={kb ? 0 : -1}
  onpointerenter={onhoverstart}
  onpointerleave={onhoverend}
>
  <div class="card-head">
    <span class="kind-ico" title={t(isNote ? 'stash.card.kind_note' : 'stash.card.kind_file')}
      ><StashIcon name={isNote ? 'note' : 'fref'} stroke={1.4} /></span
    >
    <span class="card-name"
      >{#each nameSegments as s, i (i)}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}</span
    >
    {#if holder}
      <span class="open-mark" title={t('stash.card.open_in_title')}
        >{t(isNote ? 'stash.card.open_in_note' : 'stash.card.open_in_file', { n: holder.number ?? '?' })}</span
      >
    {/if}
    {#if !adding || !isNote}
      <span class="card-acts">
        {#if !adding}
          <button
            class="tag-add"
            type="button"
            tabindex="-1"
            title={t('stash.card.tag_add_title')}
            onclick={(e) => {
              e.stopPropagation();
              void startAdding();
            }}>{t('stash.card.tag_add')}</button
          >
        {/if}
        {#if !isNote}
          <button
            class="card-rm"
            type="button"
            tabindex="-1"
            title={t('stash.card.remove_file_title')}
            onclick={(e) => {
              e.stopPropagation();
              onremove();
            }}>{t('stash.card.remove_file')}</button
          >
        {/if}
      </span>
    {/if}
  </div>
  <div class="card-meta">
    {#if away}<span class="aw">{away}</span>{/if}
    {#if isNote}<span>{noteMeta}</span>{:else}{#if entry.repo}<span>{entry.repo}</span>{/if}{#if entry.branch}<span
          class="br">⎇ {entry.branch}</span
        >{/if}{/if}
  </div>
  {#if !isNote}<div class="card-path" title={entry.path}>{repoRelativePath(entry.path, entry.repo)}</div>{/if}
  {#if hit}
    <div class="card-preview">
      <div class="hit-l">{t('tabs.drawer.in_text')}</div>
      <div class="hit">{#each hit as s, i (i)}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}</div>
    </div>
  {:else if compact}
    {#if firstLine}<div class="card-preview"><div>{firstLine}</div></div>{/if}
  {:else if preview.length > 0}
    <div class="card-preview">
      {#each preview as line, i (i)}
        <div>
          {#if line.kind === 'heading'}<b>{#each line.segs as s, j (j)}{s.text}{/each}</b>
          {:else if line.kind === 'quote'}<em>{@render segments(line.segs)}</em>
          {:else}{line.kind === 'task' ? (line.done ? '☑ ' : '☐ ') : line.kind === 'bullet' ? '• ' : ''}{@render segments(
              line.segs
            )}
          {/if}
        </div>
      {/each}
    </div>
  {/if}
  {#if hasTags}
    <div class="card-tags">
      {#if entry.repo}
        <button
          class="tag repo"
          type="button"
          tabindex="-1"
          title={t('stash.card.repo_tag_title')}
          onclick={(e) => {
            e.stopPropagation();
            if (entry.repo) onfilter(entry.repo);
          }}><StashIcon name="repo" stroke={1.4} />{entry.repo}</button
        >
      {/if}
      {#each entry.tags as tag (tag)}
        <span class="tag" class:new={newTags.includes(tag)}>
          <button
            class="tag-b"
            type="button"
            tabindex="-1"
            title={t('stash.card.tag_title', { tag })}
            onclick={(e) => {
              e.stopPropagation();
              onfilter(tag);
            }}>#{tag}</button
          ><button
            class="tag-x"
            type="button"
            tabindex="-1"
            aria-label={t('stash.card.tag_remove', { tag })}
            title={t('stash.card.tag_remove', { tag })}
            onclick={(e) => {
              e.stopPropagation();
              onsettag({ remove: [tag] });
            }}>×</button
          >
        </span>
      {/each}
      {#if adding}
        <input
          class="tag-edit"
          type="text"
          bind:this={inputEl}
          bind:value={draft}
          placeholder={t('stash.card.tag_placeholder')}
          maxlength={TAG_MAX}
          spellcheck="false"
          onkeydown={onTagKey}
          onblur={() => finish(false)}
        />
      {/if}
    </div>
  {/if}
</div>

<style>
  /* The tabs drawer's card (TabCard.svelte, mockup `.card`), plus the stash's own parts. */
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

  .card::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 12px;
    bottom: 12px;
    width: 3px;
    border-radius: 3px;
    background: var(--color-stash);
    opacity: 0;
    transform: scaleY(0.4);
    transition:
      opacity 0.2s,
      transform 0.25s var(--tabs-ease);
  }

  .card.kb {
    outline: 2px solid color-mix(in oklab, var(--text-muted) 70%, transparent);
    outline-offset: 1px;
  }

  .card.expanded {
    transform: translateX(-5px);
    box-shadow:
      0 2px 4px rgba(var(--tabs-shadow-rgb), 0.06),
      0 14px 32px rgba(var(--tabs-shadow-rgb), calc(var(--tabs-shadow-a) * 1.2));
    z-index: 2;
  }

  .card.dragging {
    opacity: 0.35;
  }

  /* Dedup: the card jumps to the top and pulses (mockup `stPulse`; no transform — flip owns it). */
  .card.pulse {
    animation: stPulse 1.1s ease 0.26s;
  }

  /* A repeat pulse: a new animation name is what makes the browser start over. */
  .card.pulse.pulse-alt {
    animation-name: stPulseAlt;
  }

  .card-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 20px;
  }

  .kind-ico {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    display: grid;
    place-items: center;
    font-size: 16px;
    color: var(--color-stash);
  }

  .card.file .kind-ico {
    color: var(--text-subtle);
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

  .open-mark {
    flex: 0 0 auto;
    font-size: 10.5px;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .open-mark::before {
    content: '';
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--tabs-brand-a);
    margin-right: 4px;
    vertical-align: 1px;
  }

  /* «+ тег» and «убрать из тайника» lie over the head's right end instead of
     sitting in its row: in the row, invisible, they kept their width and cut a
     file's name to «stash-de…» at rest. Shown on hover, with the keyboard ring,
     or while one of them has focus; the fade-in background keeps the covered
     name and «открыт в #N» from showing through. */
  .card-acts {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    padding-left: 18px;
    background: linear-gradient(to right, transparent, var(--bg-base) 16px);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s;
  }

  .card:hover .card-acts,
  .card.kb .card-acts,
  .card:focus-within .card-acts {
    opacity: 1;
    pointer-events: auto;
  }

  .card-rm,
  .tag-add {
    flex: 0 0 auto;
    border: 0;
    background: transparent;
    font: inherit;
    font-size: 11px;
    color: var(--text-muted);
    padding: 2px 6px;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
    transition:
      background-color 0.12s,
      color 0.12s;
  }

  .card-rm:hover,
  .tag-add:hover {
    background: var(--highlight);
    color: var(--text-primary);
  }

  .card-meta {
    margin-top: 2px;
    font-size: 11.5px;
    color: var(--text-muted);
    display: flex;
    gap: 6px;
    white-space: nowrap;
    overflow: hidden;
  }

  .card-meta .aw {
    color: color-mix(in oklab, var(--color-stash) 85%, var(--text-primary));
    font-weight: 600;
  }

  .br {
    font-family: var(--font-code);
    font-size: 10.5px;
  }

  .card-path {
    margin-top: 1px;
    font-family: var(--font-code);
    font-size: 10.5px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
    background: color-mix(in oklab, var(--color-stash) 24%, transparent);
    color: inherit;
    border-radius: 3px;
    padding: 0 1px;
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--color-stash) 30%, transparent);
  }

  .card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
  }

  .tag {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0 7px;
    border-radius: 999px;
    font: inherit;
    font-size: 10.5px;
    line-height: 1.6;
    color: color-mix(in oklab, var(--color-stash) 70%, var(--text-primary));
    background: var(--stash-soft);
    border: 1px solid transparent;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color 0.12s;
  }

  .tag:hover {
    border-color: color-mix(in oklab, var(--color-stash) 50%, transparent);
  }

  .tag.repo {
    background: transparent;
    border: 1px dashed color-mix(in oklab, var(--color-stash) 45%, transparent);
  }

  .tag :global(svg) {
    width: 11px;
    height: 11px;
    color: var(--color-stash);
  }

  .tag.new {
    animation: tagIn 0.9s var(--tabs-ease);
  }

  .tag-b,
  .tag-x {
    border: 0;
    padding: 0;
    background: transparent;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }

  /* The × grows in on hover, like the drawer's selection dot — no layout jump at rest. */
  .tag-x {
    width: 0;
    margin-right: -3px;
    opacity: 0;
    overflow: hidden;
    color: var(--text-muted);
    transition:
      width 0.15s var(--tabs-ease),
      margin 0.15s var(--tabs-ease),
      opacity 0.15s;
  }

  .tag:hover .tag-x {
    width: 9px;
    margin-right: 0;
    opacity: 1;
  }

  .tag-x:hover {
    color: var(--text-primary);
  }

  .tag-edit {
    width: 96px;
    padding: 0 7px;
    border: 1px solid var(--color-stash);
    border-radius: 999px;
    background: var(--bg-base);
    font: inherit;
    font-size: 10.5px;
    line-height: 1.6;
    color: var(--text-primary);
    outline: none;
    box-shadow: 0 0 0 3px var(--stash-soft);
  }

  /* Compact (View → Tabs → Compact, or both drawers squeezed): one line, but the
     «отложено …» line stays — every stash card shows when it was put away (mockup).
     Keyed on the card's own `compact` prop, the same one that picks the one-line
     preview, so markup and look cannot disagree. */
  .card.compact {
    padding: 7px 10px 7px 16px;
    border-radius: 9px;
  }

  .card.compact::before {
    top: 8px;
    bottom: 8px;
  }

  .card.compact .card-name {
    flex: 0 1 auto;
    max-width: 68%;
    font-size: 13px;
  }

  .card.compact .card-meta > :not(.aw) {
    display: none;
  }

  .card.compact .card-path {
    display: none;
  }

  .card.compact .card-preview,
  .card.compact.expanded .card-preview {
    margin-top: 1px;
    max-height: 1.55em;
    -webkit-mask-image: none;
    mask-image: none;
  }

  .card.compact .card-preview > div {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .card.compact .card-preview .hit-l {
    display: none;
  }

  .card.compact.expanded {
    transform: none;
  }

  .card.compact .card-tags {
    margin-top: 4px;
  }

  @keyframes stPulse {
    0%,
    60% {
      border-color: var(--color-stash);
      box-shadow: 0 0 0 4px color-mix(in oklab, var(--color-stash) 22%, transparent);
      background: color-mix(in oklab, var(--color-stash) 9%, var(--bg-base));
    }
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
  }

  /* stPulse's twin — keep the two identical. */
  @keyframes stPulseAlt {
    0%,
    60% {
      border-color: var(--color-stash);
      box-shadow: 0 0 0 4px color-mix(in oklab, var(--color-stash) 22%, transparent);
      background: color-mix(in oklab, var(--color-stash) 9%, var(--bg-base));
    }
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
  }

  @keyframes tagIn {
    0% {
      transform: scale(0.6);
      opacity: 0;
    }
    50% {
      transform: scale(1.15);
      box-shadow: 0 0 0 3px var(--stash-soft);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .card.pulse,
    .card.pulse.pulse-alt,
    .tag.new {
      animation: none;
    }
    .card,
    .card-preview,
    .card-acts,
    .tag-x {
      transition-duration: 0.01s !important;
    }
  }
</style>
