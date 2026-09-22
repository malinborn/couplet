import { Decoration, WidgetType } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import type { RangeSetBuilder } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { shouldReveal } from './flavour';
import type { DecoSink } from './utils';
import {
  createViewport,
  estimateFrameHeight,
  autoHeightCap,
  type ViewportController,
} from './mermaid-viewport';
import { getMermaidView, setMermaidView } from './mermaid-state';
import { t } from '../../i18n';

// -- Types --

interface MermaidCacheEntry {
  svg: string | null;
  error: string | null;
}

// -- StateEffect dispatched after a render completes --

export const mermaidRendered = StateEffect.define<null>();

// -- Lazy loader --

type MermaidAPI = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, definition: string) => Promise<{ svg: string }>;
};

let mermaidModule: MermaidAPI | null = null;
let mermaidLoading: Promise<MermaidAPI> | null = null;

/**
 * Resolves which mermaid built-in theme ('default' light / 'dark') a given
 * view's diagram should render with.
 *
 * Walks up from the view's own DOM to the nearest `[data-theme]` ancestor
 * instead of always reading `document.documentElement`. In the app there is
 * only one themed element (`<html data-theme="...">`, set in App.svelte), so
 * `closest()` resolves straight to `documentElement` and this is a no-op.
 * The landing page's demo cards each carry their own `data-theme` (see
 * `site/styles/demo-themes.css`) independent of the page's — without this,
 * every embedded diagram rendered with the *page's* theme regardless of the
 * card it sat on, so a light-themed card on a dark page got a dark diagram.
 */
export function resolveTheme(view: EditorView): 'default' | 'dark' {
  const scope = (view.dom.closest('[data-theme]') as HTMLElement | null) ?? document.documentElement;
  return scope.dataset.theme?.endsWith('dark') ? 'dark' : 'default';
}

/**
 * Cache key for a rendered diagram: the resolved mermaid theme plus the
 * source text. Deliberately coarse-grained on the *resolved* theme ('default'
 * | 'dark'), not the app's four theme names — 'light' and 'aurora-light' both
 * render as 'default', so they correctly share a cache entry instead of
 * re-rendering an identical SVG twice.
 */
export function mermaidCacheKey(view: EditorView, source: string): string {
  // The separator is written as an escape, not a raw NUL byte: a literal NUL
  // in the source makes git treat this file as binary, which silently breaks
  // diffs and merges on it. The runtime key is identical either way.
  return `${resolveTheme(view)}\u0000${source}`;
}

async function loadMermaid(): Promise<MermaidAPI> {
  if (mermaidModule) return mermaidModule;
  if (mermaidLoading) return mermaidLoading;

  mermaidLoading = import('mermaid').then((m) => {
    mermaidModule = m.default as unknown as MermaidAPI;
    return mermaidModule;
  });

  return mermaidLoading;
}

// -- Render cache (theme + content addressed) --

const cache = new Map<string, MermaidCacheEntry>();
const MAX_CACHE = 50;

export function getCached(view: EditorView, source: string): MermaidCacheEntry | undefined {
  const key = mermaidCacheKey(view, source);
  const entry = cache.get(key);
  if (entry !== undefined) {
    // Promote to most-recently-used by re-inserting at tail
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

function setCache(key: string, entry: MermaidCacheEntry): void {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, entry);
}

// -- Render queue (sequential, mermaid can't render concurrently) --

let renderCounter = 0;
let rendering = false;
const queue: Array<{
  key: string;
  source: string;
  theme: 'default' | 'dark';
  view: EditorView;
  resolve: () => void;
}> = [];

async function processQueue(): Promise<void> {
  if (rendering) return;
  rendering = true;

  while (queue.length > 0) {
    const job = queue.shift()!;
    if (cache.has(job.key) && cache.get(job.key)!.svg !== null) {
      job.resolve();
      continue;
    }

    try {
      const api = await loadMermaid();
      // Queue processing is strictly sequential (the `rendering` guard above),
      // so it's safe to flip mermaid's global theme config per job even
      // though `render()` itself takes no per-call theme argument.
      api.initialize({ startOnLoad: false, theme: job.theme, suppressErrors: true });
      const id = `mermaid-render-${renderCounter++}`;
      const { svg } = await api.render(id, job.source);
      setCache(job.key, { svg, error: null });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      const prev = cache.get(job.key);
      setCache(job.key, {
        svg: prev?.svg ?? null,
        error: errorMsg,
      });
    }

    try {
      job.view.dispatch({ effects: mermaidRendered.of(null) });
    } catch {
      // View may be destroyed
    }
    job.resolve();
  }

  rendering = false;
}

// -- Debounced render request --

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 300;

export function requestRender(view: EditorView, source: string): void {
  const key = mermaidCacheKey(view, source);
  const existing = cache.get(key);
  if (existing?.svg) return;

  const existing_timer = debounceTimers.get(key);
  if (existing_timer) clearTimeout(existing_timer);

  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key);
      void new Promise<void>((resolve) => {
        queue.push({ key, source, theme: resolveTheme(view), view, resolve });
        processQueue();
      });
    }, DEBOUNCE_MS)
  );
}

// -- Theme change: clear cache and re-render --

export function reinitializeTheme(): void {
  if (!mermaidModule) return;
  // This fires on a *page*-level theme change (the app's theme menu, or the
  // landing's toggle) — it has no specific view, so it reads the document's
  // own theme directly rather than through resolveTheme(). Demo cards with
  // their own fixed data-theme are unaffected by the page toggle in the
  // first place; the next render for any view still resolves its own theme
  // fresh via the queue in processQueue().
  const theme = document.documentElement.dataset.theme?.endsWith('dark') ? 'dark' : 'default';
  mermaidModule.initialize({
    startOnLoad: false,
    theme,
    suppressErrors: true,
  });
  cache.clear();
}

// -- Widget --

class MermaidWidget extends WidgetType {
  private controller: ViewportController | null = null;

  constructor(
    private source: string,
    private svg: string | null,
    private error: string | null,
    /** Start of the fenced block — the key under which view state is stored. */
    private pos: number,
    /**
     * Height to give the frame before layout. Without it the SVG lays out at
     * its natural size for one frame — see `createViewport`.
     */
    private frameHeight: number
  ) {
    super();
  }

  /**
   * `pos` is deliberately excluded: an edit elsewhere in the document shifts it,
   * but rebuilding the DOM would reparse the SVG on every keystroke. Commits
   * resolve the live position from the DOM instead (see `commitPos`).
   */
  eq(other: MermaidWidget): boolean {
    return (
      this.source === other.source &&
      this.svg === other.svg &&
      this.error === other.error
    );
  }

  /**
   * Live document position of this widget, snapped to its line start so it
   * matches the key `decorateMermaidBlock` restores from.
   */
  private commitPos(view: EditorView): number {
    if (!this.controller) return this.pos;
    try {
      return view.state.doc.lineAt(view.posAtDOM(this.controller.dom)).from;
    } catch {
      return this.pos;
    }
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-md-mermaid-container';

    if (this.svg) {
      this.controller = createViewport(
        this.svg,
        getMermaidView(view.state, this.pos),
        (state) => {
          view.dispatch({
            effects: setMermaidView.of({ pos: this.commitPos(view), view: state }),
          });
        },
        this.frameHeight
      );
      container.appendChild(this.controller.dom);
    }

    if (this.error) {
      const errorBar = document.createElement('div');
      errorBar.className = 'cm-md-mermaid-error';
      const msg = this.error.length > 150 ? this.error.slice(0, 147) + '...' : this.error;
      errorBar.textContent = `⚠ ${msg}`;
      container.appendChild(errorBar);
    }

    if (!this.svg && !this.error) {
      const placeholder = document.createElement('div');
      placeholder.className = 'cm-md-mermaid-placeholder';
      placeholder.textContent = t('editor.mermaid.rendering');
      container.appendChild(placeholder);
    }

    return container;
  }

  destroy(): void {
    this.controller?.destroy();
    this.controller = null;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// -- Decorator function (called from plugin.ts) --

export function decorateMermaidBlock(
  view: EditorView,
  node: SyntaxNode,
  builder: DecoSink
): void {
  if (shouldReveal(view, 'mermaid', node.from, node.to, true)) return;

  const doc = view.state.doc;
  const startLine = doc.lineAt(node.from);
  const endLine = doc.lineAt(node.to);

  const firstContentLineNum = startLine.number + 1;
  const lastContentLineNum = endLine.number - 1;
  const hasContent = firstContentLineNum <= lastContentLineNum;

  if (!hasContent) return;

  const source = doc.sliceString(
    doc.line(firstContentLineNum).from,
    doc.line(lastContentLineNum).to
  );

  if (!source.trim()) return;

  const cached = getCached(view, source);
  const svg = cached?.svg ?? null;
  const error = cached?.error ?? null;

  if (!cached || !cached.svg) {
    requestRender(view, source);
  }

  // Tell CM6 how tall this will be before it is ever laid out, so its height map
  // is right for diagrams outside the viewport.
  const stored = getMermaidView(view.state, startLine.from);
  const frameHeight = estimateFrameHeight(
    svg,
    stored?.frameHeight ?? null,
    view.contentDOM.clientWidth,
    autoHeightCap()
  );

  // Hide all lines of the fenced block, replace with widget on first line
  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = doc.line(i);

    if (i === startLine.number) {
      // First line hosts the widget — do NOT hide it (no height:0 class).
      // The line class carries `contain: inline-size`, which keeps the
      // natural-width SVG from stretching .cm-content and breaking wrapping.
      // Line decoration goes before replace at the same position (lower startSide).
      builder.add(
        line.from,
        line.from,
        Decoration.line({ class: 'cm-md-mermaid-host-line' })
      );
      builder.add(
        line.from,
        line.to,
        Decoration.replace({
          widget: new MermaidWidget(source, svg, error, startLine.from, frameHeight),
        })
      );
    } else {
      builder.add(
        line.from,
        line.from,
        Decoration.line({ class: 'cm-md-mermaid-line-hidden' })
      );
      if (line.length > 0) {
        builder.add(line.from, line.to, Decoration.replace({}));
      }
    }
  }
}
