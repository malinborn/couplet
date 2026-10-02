import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers, type Command, type Panel, type ViewUpdate } from '@codemirror/view';
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchPanelOpen,
  setSearchQuery,
} from '@codemirror/search';
import { t } from '../../i18n';
import { formatCounter, matchIndexAt, searchMatches, searchMatchesField, type Counter } from './match-count';
import { searchFocusField, setSearchFocus } from './panel-focus';
import { widgetMatchHighlights } from './widget-matches';

/**
 * The Find panel: one compact row at the bottom of the editor.
 *
 *   [ query ……………… 3 / 17 ]  ↑  ↓  │  Aa  .*  W  │  ⇄          ×
 *   [ replacement ………… ]  Заменить  Заменить все        (⇄ opens it)
 *
 * It replaces CodeMirror's default panel (English labels, checkboxes, no
 * counter) through `search({ createPanel })`; the search state, the commands
 * and the highlighter are still `@codemirror/search`'s own, so findNext, the
 * keymap and the live-render caret filter see exactly the transactions they
 * always did.
 *
 * Buttons never take focus on mousedown: the keyboard stays in the query
 * field, so clicking ↓ or Aa does not interrupt typing — and does not switch
 * the spotlight off, which follows focus in the fields (`panel-focus.ts`).
 */

const ICON_UP =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_DOWN =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_REPLACE =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 5.5h9M9.5 3l2.5 2.5L9.5 8M13 10.5H4M6.5 8L4 10.5 6.5 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  attrs: Record<string, string> = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

/** A button that runs `action` without moving focus out of the field. */
function button(className: string, label: string, action: () => void, content: { icon?: string; text?: string }): HTMLButtonElement {
  const b = el('button', `cm-md-search-btn ${className}`, { type: 'button', title: label, 'aria-label': label });
  if (content.icon) b.innerHTML = content.icon;
  else if (content.text) b.textContent = content.text;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', action);
  return b;
}

class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = false;
  private query: SearchQuery;
  private readonly searchInput: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly searchField: HTMLElement;
  private readonly counter: HTMLElement;
  private readonly caseBtn: HTMLButtonElement;
  private readonly regexpBtn: HTMLButtonElement;
  private readonly wordBtn: HTMLButtonElement;
  private readonly replaceToggle: HTMLButtonElement;
  private readonly replaceRow: HTMLElement;
  private shown: Counter | null = null;
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    const readOnly = view.state.readOnly;

    this.searchInput = el('input', 'cm-md-search-input', {
      name: 'search',
      'main-field': 'true',
      placeholder: t('search.find_placeholder'),
      'aria-label': t('search.find_placeholder'),
      autocomplete: 'off',
      spellcheck: 'false',
    });
    this.searchInput.value = this.query.search;
    this.searchInput.addEventListener('input', () => this.commit());

    this.counter = el('span', 'cm-md-search-count', { 'aria-live': 'polite' });
    this.searchField = el('div', 'cm-md-search-field');
    this.searchField.append(this.searchInput, this.counter);

    this.replaceInput = el('input', 'cm-md-search-input', {
      name: 'replace',
      placeholder: t('search.replace_placeholder'),
      'aria-label': t('search.replace_placeholder'),
      autocomplete: 'off',
      spellcheck: 'false',
    });
    this.replaceInput.value = this.query.replace;
    this.replaceInput.addEventListener('input', () => this.commit());

    const toggle = (btn: () => HTMLButtonElement) => () => {
      const b = btn();
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
      this.commit();
    };
    this.caseBtn = button('cm-md-search-toggle', t('search.match_case'), toggle(() => this.caseBtn), { text: 'Aa' });
    this.regexpBtn = button('cm-md-search-toggle', t('search.regexp'), toggle(() => this.regexpBtn), { text: '.*' });
    this.wordBtn = button('cm-md-search-toggle cm-md-search-word', t('search.whole_word'), toggle(() => this.wordBtn), {
      text: 'W',
    });
    this.replaceToggle = button('cm-md-search-toggle', t('search.toggle_replace'), () => this.setReplaceOpen(this.replaceRow.hidden, true), {
      icon: ICON_REPLACE,
    });

    const sep = (): HTMLElement => el('span', 'cm-md-search-sep', { 'aria-hidden': 'true' });
    const spacer = el('span', 'cm-md-search-spacer');
    const findRow = el('div', 'cm-md-search-row');
    findRow.append(
      this.searchField,
      button('', t('search.previous'), () => findPrevious(this.view), { icon: ICON_UP }),
      button('', t('search.next'), () => findNext(this.view), { icon: ICON_DOWN }),
      sep(),
      this.caseBtn,
      this.regexpBtn,
      this.wordBtn,
      ...(readOnly ? [] : [sep(), this.replaceToggle]),
      spacer,
      button('cm-md-search-close', t('search.close'), () => closeSearchPanel(this.view), { icon: ICON_CLOSE })
    );

    const replaceField = el('div', 'cm-md-search-field');
    replaceField.append(this.replaceInput);
    this.replaceRow = el('div', 'cm-md-search-row cm-md-search-replace');
    this.replaceRow.append(
      replaceField,
      button('cm-md-search-text', t('search.replace_one'), () => replaceNext(this.view), { text: t('search.replace_one') }),
      button('cm-md-search-text', t('search.replace_all'), () => replaceAll(this.view), { text: t('search.replace_all') })
    );
    this.setReplaceOpen(false, false);

    this.dom = el('div', 'cm-md-search', { role: 'search' });
    this.dom.append(findRow, this.replaceRow);
    this.dom.addEventListener('keydown', (e) => this.keydown(e));
    this.dom.addEventListener('focusin', () => this.reportFocus());
    this.dom.addEventListener('focusout', () => this.reportFocus());

    this.syncToggles(this.query);
    // A replacement left over from the last search means the human was
    // replacing: reopen the row they were using.
    if (!readOnly && this.query.replace) this.setReplaceOpen(true, false);
    this.refreshCounter();
  }

  mount(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }

  update(update: ViewUpdate): void {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) this.setQuery(effect.value);
      }
    }
    this.refreshCounter();
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Build the query from the fields and push it into the search state if it changed. */
  private commit(): void {
    const query = new SearchQuery({
      search: this.searchInput.value,
      replace: this.replaceInput.value,
      caseSensitive: this.caseBtn.getAttribute('aria-pressed') === 'true',
      regexp: this.regexpBtn.getAttribute('aria-pressed') === 'true',
      wholeWord: this.wordBtn.getAttribute('aria-pressed') === 'true',
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  /** A query set from outside — ⌘F with a selection, mostly. */
  private setQuery(query: SearchQuery): void {
    this.query = query;
    this.searchInput.value = query.search;
    this.replaceInput.value = query.replace;
    this.syncToggles(query);
  }

  private syncToggles(query: SearchQuery): void {
    this.caseBtn.setAttribute('aria-pressed', String(query.caseSensitive));
    this.regexpBtn.setAttribute('aria-pressed', String(query.regexp));
    this.wordBtn.setAttribute('aria-pressed', String(query.wholeWord));
  }

  private setReplaceOpen(open: boolean, focus: boolean): void {
    this.replaceRow.hidden = !open;
    this.replaceToggle.setAttribute('aria-pressed', String(open));
    this.replaceToggle.setAttribute('aria-expanded', String(open));
    if (focus) (open ? this.replaceInput : this.searchInput).focus();
  }

  private refreshCounter(): void {
    const { state } = this.view;
    const next = formatCounter(getSearchQuery(state), searchMatches(state), state.selection.main, {
      none: t('search.no_matches'),
      invalid: t('search.invalid'),
    });
    const prev = this.shown;
    if (prev && prev.text === next.text && prev.state === next.state) return;
    this.shown = next;
    this.counter.textContent = next.text;
    this.searchField.dataset.state = next.state;
    if (next.state === 'on' && next.index !== null) {
      this.counter.setAttribute('aria-label', t('search.count', { index: next.index, total: next.total }));
    } else {
      this.counter.removeAttribute('aria-label');
    }
  }

  private keydown(e: KeyboardEvent): void {
    // ⌘F inside the panel, and Esc, ⌘G, F3 — everything bound to the
    // `search-panel` scope (see `findPanel()` and `searchKeymap`).
    if (runScopeHandlers(this.view, e, 'search-panel')) {
      e.preventDefault();
      return;
    }
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    if (e.target === this.searchInput) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.target === this.replaceInput) {
      e.preventDefault();
      (e.metaKey || e.ctrlKey ? replaceAll : replaceNext)(this.view);
    }
  }

  /**
   * Tell the editor whether a field has the keyboard. Deferred to a microtask:
   * focus events also fire from inside an editor update (the panel mounting
   * and focusing its field, ⌘F refocusing it), and dispatching from there
   * throws. By the microtask the focus has settled, so this reads the result,
   * not the transition.
   */
  private reportFocus(): void {
    queueMicrotask(() => {
      if (this.destroyed) return;
      const active = this.view.root.activeElement;
      const focused = active === this.searchInput || active === this.replaceInput;
      if (focused !== this.view.state.field(searchFocusField, false)) {
        this.view.dispatch({ effects: setSearchFocus.of(focused) });
      }
    });
  }
}

/** The query field of the open panel, if there is one. */
function searchInputOf(view: EditorView): HTMLInputElement | null {
  return view.dom.querySelector<HTMLInputElement>('.cm-md-search [main-field]');
}

/**
 * ⌘F. Opens the panel (seeding the query from a short selection), or focuses
 * it — and when the query field already has the keyboard, selects its text so
 * the next keystroke starts a new query. CodeMirror's own `openSearchPanel`
 * does nothing in that last case.
 */
export const openFind: Command = (view) => {
  const input = searchInputOf(view);
  if (searchPanelOpen(view.state) && input && view.root.activeElement === input) {
    input.select();
    return true;
  }
  return openSearchPanel(view);
};

/**
 * `cm-md-search-on-match` on the editor while the selection is exactly a
 * match — which is what findNext leaves behind. The selection layer is hidden
 * then (search.css): the current match's solid fill already marks it, and the
 * taller selection rectangle peeking out around it read as a second frame.
 */
const NO_ATTRS: Record<string, string> = {};
const ON_MATCH: Record<string, string> = { class: 'cm-md-search-on-match' };
const onMatchClass = EditorView.editorAttributes.compute([searchMatchesField, 'selection'], (state) => {
  const { from, to } = state.selection.main;
  const on = from !== to && searchPanelOpen(state) && matchIndexAt(searchMatches(state), from, to) >= 0;
  return on ? ON_MATCH : NO_ATTRS;
});

/** The search state with this panel, and ⌘F that knows about it. */
export function findPanel(): Extension {
  return [
    search({ createPanel: (view) => new FindPanel(view) }),
    searchMatchesField,
    searchFocusField,
    onMatchClass,
    widgetMatchHighlights,
    // Above `searchKeymap`'s Mod-f, in both scopes: the editor's and the
    // panel's own (`runScopeHandlers` in `keydown`).
    Prec.high(keymap.of([{ key: 'Mod-f', run: openFind, scope: 'editor search-panel', preventDefault: true }])),
  ];
}
