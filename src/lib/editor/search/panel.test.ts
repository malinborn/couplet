// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { closeSearchPanel, getSearchQuery, openSearchPanel, searchKeymap, searchPanelOpen } from '@codemirror/search';
import { findPanel, openFind } from './panel';
import { searchMatches, searchMatchesField } from './match-count';
import { searchFocusField } from './panel-focus';
import { searchSpotlight, spotlightOn, spotlightVariant } from './spotlight';

const DOC = 'Поиск один. Второй поиск. Третий ПОИСК.';

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view?.dom.remove();
  view = null;
});

function make(doc = DOC, extra: Extension[] = []): EditorView {
  const parent = document.createElement('div');
  document.body.append(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [findPanel(), searchSpotlight(), keymap.of(searchKeymap), ...extra],
    }),
  });
  return view;
}

function panel(v: EditorView): HTMLElement {
  const dom = v.dom.querySelector<HTMLElement>('.cm-md-search');
  if (!dom) throw new Error('panel not open');
  return dom;
}

function input(v: EditorView, name = 'search'): HTMLInputElement {
  const el = panel(v).querySelector<HTMLInputElement>(`input[name=${name}]`);
  if (!el) throw new Error(`no ${name} field`);
  return el;
}

function type(field: HTMLInputElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function key(field: HTMLElement, init: KeyboardEventInit): void {
  field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

function counter(v: EditorView): string {
  return panel(v).querySelector('.cm-md-search-count')?.textContent ?? '';
}

function fieldState(v: EditorView): string | undefined {
  return panel(v).querySelector<HTMLElement>('.cm-md-search-field')?.dataset.state;
}

const settle = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

describe('the Find panel', () => {
  it('replaces the default panel and focuses its query field', () => {
    const v = make();
    openSearchPanel(v);
    expect(v.dom.querySelector('.cm-search')).toBeNull();
    expect(input(v).hasAttribute('main-field')).toBe(true);
    expect(document.activeElement).toBe(input(v));
  });

  it('counts the matches of what is typed, and says when the selection is not one', () => {
    const v = make();
    openSearchPanel(v);
    type(input(v), 'поиск');
    expect(getSearchQuery(v.state).search).toBe('поиск');
    expect(searchMatches(v.state).from).toHaveLength(3);
    expect(counter(v)).toBe('– / 3');
    expect(fieldState(v)).toBe('off');
  });

  it('Enter steps forward, Shift+Enter back, and the counter follows', () => {
    const v = make();
    openSearchPanel(v);
    type(input(v), 'поиск');
    key(input(v), { key: 'Enter' });
    expect(v.state.selection.main.from).toBe(0);
    expect(counter(v)).toBe('1 / 3');
    key(input(v), { key: 'Enter' });
    expect(counter(v)).toBe('2 / 3');
    key(input(v), { key: 'Enter', shiftKey: true });
    expect(counter(v)).toBe('1 / 3');
    key(input(v), { key: 'Enter', shiftKey: true });
    expect(counter(v)).toBe('3 / 3');
  });

  it('shows "no matches" and the miss state for a query with no hits, nothing for an empty one', () => {
    const v = make();
    openSearchPanel(v);
    type(input(v), 'zzz');
    expect(counter(v)).toBe('no matches');
    expect(fieldState(v)).toBe('none');
    type(input(v), '');
    expect(counter(v)).toBe('');
    expect(fieldState(v)).toBe('empty');
  });

  it('flags a regexp that does not compile', () => {
    const v = make();
    openSearchPanel(v);
    const regexp = panel(v).querySelectorAll<HTMLButtonElement>('.cm-md-search-toggle')[1];
    regexp.click();
    type(input(v), '(');
    expect(getSearchQuery(v.state).regexp).toBe(true);
    expect(fieldState(v)).toBe('invalid');
  });

  it('the toggles change the query and show their state', () => {
    const v = make();
    openSearchPanel(v);
    type(input(v), 'поиск');
    const [matchCase, , wholeWord] = panel(v).querySelectorAll<HTMLButtonElement>('.cm-md-search-toggle');
    matchCase.click();
    expect(matchCase.getAttribute('aria-pressed')).toBe('true');
    expect(getSearchQuery(v.state).caseSensitive).toBe(true);
    expect(counter(v)).toBe('– / 1');
    wholeWord.click();
    expect(getSearchQuery(v.state).wholeWord).toBe(true);
  });

  it('a toggle click does not take focus from the field', () => {
    const v = make();
    openSearchPanel(v);
    const matchCase = panel(v).querySelector<HTMLButtonElement>('.cm-md-search-toggle');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    matchCase?.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('⌘F with the field focused selects the query instead of doing nothing', () => {
    const v = make();
    openSearchPanel(v);
    type(input(v), 'поиск');
    input(v).setSelectionRange(5, 5);
    expect(openFind(v)).toBe(true);
    expect([input(v).selectionStart, input(v).selectionEnd]).toEqual([0, 5]);
  });

  it('⌘F from the editor opens the panel, seeding the query from a short selection', () => {
    const v = make();
    v.dispatch({ selection: EditorSelection.range(12, 18) });
    openFind(v);
    expect(searchPanelOpen(v.state)).toBe(true);
    expect(input(v).value).toBe('Второй');
  });

  it('Escape closes the panel and gives the editor its focus back', () => {
    const v = make();
    openSearchPanel(v);
    key(input(v), { key: 'Escape' });
    expect(searchPanelOpen(v.state)).toBe(false);
    expect(v.dom.querySelector('.cm-md-search')).toBeNull();
  });

  it('replace row: opens from ⇄, replaces one, then all', () => {
    const v = make();
    openSearchPanel(v);
    type(input(v), 'поиск');
    const toggle = panel(v).querySelector<HTMLButtonElement>('.cm-md-search-toggle[aria-expanded]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    toggle?.click();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    type(input(v, 'replace'), 'X');
    key(input(v), { key: 'Enter' });
    key(input(v, 'replace'), { key: 'Enter' });
    expect(v.state.doc.toString()).toBe('X один. Второй поиск. Третий ПОИСК.');
    key(input(v, 'replace'), { key: 'Enter', metaKey: true });
    expect(v.state.doc.toString()).toBe('X один. Второй X. Третий X.');
    expect(counter(v)).toBe('no matches');
  });

  it('keeps no match list while closed', () => {
    const v = make();
    openSearchPanel(v);
    type(input(v), 'поиск');
    expect(searchMatches(v.state).from).toHaveLength(3);
    closeSearchPanel(v);
    expect(v.state.field(searchMatchesField).query).toBeNull();
    expect(searchMatches(v.state).from).toHaveLength(0);
  });

  it('recounts after an edit while open', () => {
    const v = make();
    openSearchPanel(v);
    type(input(v), 'поиск');
    v.dispatch({ changes: { from: v.state.doc.length, insert: ' поиск' } });
    expect(counter(v)).toBe('– / 4');
  });
});

describe('the spotlight switch', () => {
  it('is on only while a field has focus and the query has matches', async () => {
    const v = make();
    openSearchPanel(v);
    await settle();
    expect(v.state.field(searchFocusField)).toBe(true);
    expect(spotlightOn(v.state)).toBe(false); // empty query
    type(input(v), 'поиск');
    expect(spotlightOn(v.state)).toBe(true);
    type(input(v), 'zzz');
    expect(spotlightOn(v.state)).toBe(false);
    type(input(v), 'поиск');
    v.focus();
    await settle();
    expect(v.state.field(searchFocusField)).toBe(false);
    expect(spotlightOn(v.state)).toBe(false);
    input(v).focus();
    await settle();
    expect(spotlightOn(v.state)).toBe(true);
  });

  it('turns off with the panel', async () => {
    const v = make();
    openSearchPanel(v);
    type(input(v), 'поиск');
    await settle();
    expect(spotlightOn(v.state)).toBe(true);
    closeSearchPanel(v);
    await settle();
    expect(v.state.field(searchFocusField)).toBe(false);
    expect(spotlightOn(v.state)).toBe(false);
  });

  it('variant "off" never dims', async () => {
    const v = make(DOC, [spotlightVariant.of('off')]);
    openSearchPanel(v);
    type(input(v), 'поиск');
    await settle();
    expect(spotlightOn(v.state)).toBe(false);
  });

  it('the veil is the default variant', () => {
    expect(EditorState.create({ extensions: [] }).facet(spotlightVariant)).toBe('veil');
  });

  it('line focus dims the visible lines that hold no match', async () => {
    const v = make('a поиск\nb\nc поиск\nd', [spotlightVariant.of('lines')]);
    openSearchPanel(v);
    type(input(v), 'поиск');
    await settle();
    const dimmed = [...v.contentDOM.querySelectorAll('.cm-line')].map((l) => l.classList.contains('cm-md-search-dim'));
    expect(dimmed).toEqual([false, true, false, true]);
    v.focus();
    await settle();
    expect(v.contentDOM.querySelector('.cm-md-search-dim')).toBeNull();
  });
});
